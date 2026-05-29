export const GRAPH_COLORS = [
  "#3b82f6",
  "#10b981",
  "#ef4444",
  "#8b5cf6",
  "#f59e0b",
  "#06b6d4",
  "#f97316",
  "#ec4899",
];

export type GraphPipe = {
  fromCol: number;
  toCol: number;
  color: number;
};

export type GraphRow = {
  commitCol: number;
  commitColor: number;
  topPipes: GraphPipe[];
  bottomPipes: GraphPipe[];
};

type Wire = { sha: string; color: number } | null;

export function computeGitGraph(commits: readonly { sha: string; parents: string[] }[]): {
  rows: GraphRow[];
  maxCols: number;
} {
  if (commits.length === 0) return { rows: [], maxCols: 0 };

  const shaSet = new Set(commits.map((c) => c.sha));
  const rows: GraphRow[] = [];
  const wires: Wire[] = [];
  let nextColor = 0;
  let globalMaxCols = 1;

  function allocColor(): number {
    return nextColor++ % GRAPH_COLORS.length;
  }

  function findFreeSlot(): number {
    const idx = wires.indexOf(null);
    if (idx >= 0) return idx;
    wires.push(null);
    return wires.length - 1;
  }

  function trimWires() {
    while (wires.length > 0 && wires[wires.length - 1] === null) wires.pop();
  }

  for (let r = 0; r < commits.length; r++) {
    const commit = commits[r];
    const parents = commit.parents.filter((p) => shaSet.has(p));

    const prevWires: Wire[] = wires.map((w) => (w ? { ...w } : null));

    const matchCols: number[] = [];
    for (let i = 0; i < wires.length; i++) {
      if (wires[i]?.sha === commit.sha) matchCols.push(i);
    }

    let commitCol: number;
    let commitColor: number;

    if (matchCols.length > 0) {
      commitCol = matchCols[0];
      commitColor = wires[commitCol]?.color ?? 0;
      for (const mc of matchCols) wires[mc] = null;
    } else {
      commitCol = findFreeSlot();
      commitColor = allocColor();
    }

    const newParentSlots = new Set<number>();

    if (parents.length >= 1) {
      wires[commitCol] = { sha: parents[0], color: commitColor };
    }

    for (let p = 1; p < parents.length; p++) {
      const pSha = parents[p];
      if (wires.some((w) => w?.sha === pSha)) continue;
      const slot = findFreeSlot();
      const color = allocColor();
      wires[slot] = { sha: pSha, color };
      newParentSlots.add(slot);
    }

    trimWires();

    const topPipes: GraphPipe[] = [];
    for (let i = 0; i < prevWires.length; i++) {
      const pw = prevWires[i];
      if (pw === null) continue;
      if (pw.sha === commit.sha) {
        topPipes.push({ fromCol: i, toCol: commitCol, color: pw.color });
      } else {
        topPipes.push({ fromCol: i, toCol: i, color: pw.color });
      }
    }

    const bottomPipes: GraphPipe[] = [];
    for (let i = 0; i < wires.length; i++) {
      const w = wires[i];
      if (w === null) continue;
      if (newParentSlots.has(i)) {
        bottomPipes.push({ fromCol: commitCol, toCol: i, color: w.color });
      } else {
        bottomPipes.push({ fromCol: i, toCol: i, color: w.color });
      }
    }

    const maxCols = Math.max(prevWires.length, wires.length, commitCol + 1);
    if (maxCols > globalMaxCols) globalMaxCols = maxCols;

    rows.push({ commitCol, commitColor, topPipes, bottomPipes });
  }

  return { rows, maxCols: globalMaxCols };
}
