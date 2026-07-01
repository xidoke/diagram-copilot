import { useEffect, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'

// ─── The architecture graph (the hard case: nested subnets + cross-tier edges) ───
const NAMES: Record<string, string> = {
  client: 'Client', cdn: 'CloudFront', vpc: 'VPC', public: 'Public subnet',
  private: 'Private subnet', alb: 'ALB', api: 'API service', worker: 'Worker',
  redis: 'Redis', postgres: 'Postgres', queue: 'SQS',
}
const COLORS: Record<string, string> = {
  client: '#61dafb', cdn: '#8a63d2', alb: '#28c840', api: '#ff9900',
  worker: '#ffb454', redis: '#d64ea3', postgres: '#336fe0', queue: '#f28cb1',
}

const W = 168
const H = 48

const graph: ElkNode = {
  id: 'root',
  layoutOptions: {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.nodeNodeBetweenLayers': '70',
    'elk.spacing.nodeNode': '40',
    'elk.layered.spacing.edgeNodeBetweenLayers': '30',
    'elk.padding': '[top=24,left=24,bottom=24,right=24]',
  },
  children: [
    { id: 'client', width: W, height: H },
    { id: 'cdn', width: W, height: H },
    {
      id: 'vpc',
      layoutOptions: { 'elk.padding': '[top=34,left=18,bottom=18,right=18]' },
      children: [
        {
          id: 'public',
          layoutOptions: { 'elk.padding': '[top=30,left=16,bottom=16,right=16]' },
          children: [{ id: 'alb', width: W, height: H }],
        },
        {
          id: 'private',
          layoutOptions: { 'elk.padding': '[top=30,left=16,bottom=16,right=16]' },
          children: [
            { id: 'api', width: W, height: H },
            { id: 'worker', width: W, height: H },
            { id: 'redis', width: W, height: H },
            { id: 'postgres', width: W, height: H },
            { id: 'queue', width: W, height: H },
          ],
        },
      ],
    },
  ],
  edges: [
    { id: 'e1', sources: ['client'], targets: ['cdn'] },
    { id: 'e2', sources: ['cdn'], targets: ['alb'] },
    { id: 'e3', sources: ['alb'], targets: ['api'] },
    { id: 'e4', sources: ['api'], targets: ['redis'], labels: [{ text: 'cache' }] },
    { id: 'e5', sources: ['api'], targets: ['postgres'], labels: [{ text: 'query' }] },
    { id: 'e6', sources: ['api'], targets: ['queue'] },
    { id: 'e7', sources: ['queue'], targets: ['worker'] },
    { id: 'e8', sources: ['worker'], targets: ['postgres'] },
  ],
}

// ─── Custom nodes (theme B: dark blueprint) ───
function LeafNode({ data }: NodeProps) {
  const kind = data.kind as string
  return (
    <div className="nd">
      <Handle type="target" position={Position.Left} className="hdl" />
      <span className="chip" style={{ background: COLORS[kind] ?? '#7f92c0' }} />
      <span className="lbl">{data.label as string}</span>
      <Handle type="source" position={Position.Right} className="hdl" />
    </div>
  )
}
function GroupNode({ data }: NodeProps) {
  return (
    <div className="grp">
      <span className="grp-label">{data.label as string}</span>
    </div>
  )
}
const nodeTypes = { leaf: LeafNode, group: GroupNode }

// ─── ELK result → React Flow nodes ───
function toReactFlow(elk: ElkNode): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const walk = (n: ElkNode, parentId?: string) => {
    for (const c of n.children ?? []) {
      const isGroup = !!(c.children && c.children.length)
      nodes.push({
        id: c.id,
        type: isGroup ? 'group' : 'leaf',
        position: { x: c.x ?? 0, y: c.y ?? 0 },
        data: { label: NAMES[c.id] ?? c.id, kind: c.id },
        style: { width: c.width, height: c.height },
        ...(parentId ? { parentId, extent: 'parent' as const } : {}),
        selectable: !isGroup,
        draggable: !isGroup,
      })
      if (isGroup) walk(c, c.id)
    }
  }
  walk(elk)
  const edges: Edge[] = (elk.edges ?? []).map((e: any) => ({
    id: e.id,
    source: e.sources[0],
    target: e.targets[0],
    label: e.labels?.[0]?.text,
    type: 'smoothstep',
    style: { stroke: '#4aa3ff', strokeWidth: 1.6 },
    labelStyle: { fill: '#9fc7ff', fontSize: 11 },
    labelBgStyle: { fill: '#0c0f16' },
  }))
  return { nodes, edges }
}

function Flow() {
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [ms, setMs] = useState<number>(0)
  const { fitView } = useReactFlow()

  useEffect(() => {
    const elk = new ELK()
    const t0 = performance.now()
    elk.layout(structuredClone(graph)).then((res) => {
      setMs(Math.round(performance.now() - t0))
      const { nodes, edges } = toReactFlow(res)
      setNodes(nodes)
      setEdges(edges)
    })
  }, [])

  useEffect(() => {
    if (nodes.length) {
      const t = setTimeout(() => fitView({ padding: 0.12, duration: 300 }), 60)
      return () => clearTimeout(t)
    }
  }, [nodes.length, fitView])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0b0e14' }}>
      <div className="hud">
        spike · React Flow + elkjs · layered · INCLUDE_CHILDREN · orthogonal —{' '}
        <b>layout {ms}ms</b>, {nodes.length} nodes, {edges.length} edges
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#1a2740" />
        <Controls />
      </ReactFlow>
    </div>
  )
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  )
}
