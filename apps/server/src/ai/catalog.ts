// Models offered in the AI workstation. Sizes are the download sizes of the
// default (4-bit) builds on ollama.com; any other model can be pulled by name.

export interface CatalogModel {
  name: string;
  label: string;
  size: number; // bytes to download (roughly the RAM it needs, plus context)
  tools: boolean; // can drive the agent's tools
  note: string;
}

const GB = 1e9;

export const CATALOG: CatalogModel[] = [
  { name: "qwen2.5-coder:1.5b", label: "Qwen2.5 Coder 1.5B", size: 1.0 * GB, tools: true, note: "Fastest. Quick questions and small edits." },
  { name: "qwen2.5-coder:3b", label: "Qwen2.5 Coder 3B", size: 1.9 * GB, tools: true, note: "Best fit for an 8 GB machine running a Bitcoin node." },
  { name: "qwen3:4b", label: "Qwen3 4B", size: 2.5 * GB, tools: true, note: "Thinks before answering. A good small agent." },
  { name: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", size: 4.7 * GB, tools: true, note: "Strong coder. Wants 12 GB+ of RAM." },
  { name: "qwen3:8b", label: "Qwen3 8B", size: 5.2 * GB, tools: true, note: "Strong all-round agent. Wants 12 GB+ of RAM." },
  { name: "qwen2.5-coder:14b", label: "Qwen2.5 Coder 14B", size: 9.0 * GB, tools: true, note: "Very good coder. Wants 16 GB+ of RAM or a GPU." },
  { name: "gpt-oss:20b", label: "gpt-oss 20B", size: 14 * GB, tools: true, note: "OpenAI's open model; strong reasoning. Wants a GPU PC." },
  { name: "devstral:24b", label: "Devstral 24B", size: 14 * GB, tools: true, note: "Built for coding agents. Wants a GPU PC." },
  { name: "qwen3-coder:30b", label: "Qwen3 Coder 30B", size: 19 * GB, tools: true, note: "Top local coding agent. Wants a GPU PC with 24 GB+." },
];

// Will this model run in `ramBytes` alongside the Bitcoin node? Leaves room for
// the context window and the rest of NovaEtherOS.
export function fitsIn(size: number, ramBytes: number) {
  return size * 1.2 + 2.5 * GB <= ramBytes;
}
