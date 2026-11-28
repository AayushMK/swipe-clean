"""Turn a quantized (QLinear*/QDQ) ONNX model into an ordinary float model with the same weights.

Used to convert OpenCV's int8 SFace model so it can go through onnx2torch -> coremltools.
Usage: python tools/dequantize_onnx.py in.onnx out.onnx
"""
import sys
import numpy as np
import onnx
from onnx import helper, numpy_helper

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
init = {t.name: numpy_helper.to_array(t) for t in g.initializer}
alias = {}          # quantized tensor name -> float tensor name
nodes, new_inits = [], {}

def f(name):        # float version of a tensor
    return alias.get(name, name)

def deq(q, s, z, axis=None):
    q = init[q].astype(np.float32); s = init[s].astype(np.float32); z = init[z].astype(np.float32)
    if s.ndim == 1 and s.size > 1:                     # per-channel (axis 0 for conv weights)
        shape = [-1] + [1] * (q.ndim - 1)
        return (q - z.reshape(shape)) * s.reshape(shape)
    return (q - z) * s

def const(name, arr):
    new_inits[name] = numpy_helper.from_array(arr.astype(np.float32), name)
    return name

for n in g.node:
    i, o = list(n.input), list(n.output)
    attrs = {a.name: helper.get_attribute_value(a) for a in n.attribute}
    if n.op_type == 'QuantizeLinear':
        alias[o[0]] = f(i[0])
    elif n.op_type == 'DequantizeLinear':
        if i[0] in init:
            alias[o[0]] = const(o[0] + '_f', deq(i[0], i[1], i[2]))
        else:
            alias[o[0]] = f(i[0])
    elif n.op_type == 'QLinearConv':
        a, a_s, _, w, w_s, w_z, _, _ = i[:8]
        W = deq(w, w_s, w_z)
        ins = [f(a), const(o[0] + '_W', W)]
        if len(i) > 8 and i[8]:
            b = init[i[8]].astype(np.float32) * init[a_s].astype(np.float32) * init[w_s].astype(np.float32)
            ins.append(const(o[0] + '_B', b))
        out = o[0] + '_f'
        nodes.append(helper.make_node('Conv', ins, [out], **attrs))
        alias[o[0]] = out
    elif n.op_type == 'QLinearMatMul':
        a, _, _, b, b_s, b_z = i[:6]
        B = deq(b, b_s, b_z) if b in init else None
        out = o[0] + '_f'
        nodes.append(helper.make_node('MatMul', [f(a), const(o[0] + '_Bm', B) if B is not None else f(b)], [out]))
        alias[o[0]] = out
    elif n.op_type in ('QLinearMul', 'QLinearAdd'):
        a, _, _, b, b_s, b_z = i[:6]
        bb = const(o[0] + '_b', deq(b, b_s, b_z)) if b in init else f(b)
        out = o[0] + '_f'
        nodes.append(helper.make_node('Mul' if n.op_type == 'QLinearMul' else 'Add', [f(a), bb], [out]))
        alias[o[0]] = out
    else:
        nn = helper.make_node(n.op_type, [f(x) if x else x for x in i], o, domain=n.domain, **attrs)
        nodes.append(nn)

outputs = []
for out in g.output:
    name = f(out.name)
    if name != out.name:
        nodes.append(helper.make_node('Identity', [name], [out.name]))
    outputs.append(out)

used = {x for nd in nodes for x in nd.input}
keep = [t for t in g.initializer if t.name in used and t.name not in new_inits]
graph = helper.make_graph(nodes, g.name, [x for x in g.input if x.name not in init], outputs,
                          keep + [new_inits[k] for k in new_inits if k in used])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, dst)
print('saved', dst)
