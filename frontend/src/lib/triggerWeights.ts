/** UI ratios include every enabled situation; runtime filters by conditions and cooldown first. */
export function weightShares(rows: {weight:number}[]): number[] {
  const max=Math.max(0,...rows.map(r=>Number.isFinite(r.weight)?r.weight:0));
  if (!max) return rows.map(()=>0);
  const scaled=rows.map(r=>Number.isFinite(r.weight)?Math.max(0,r.weight)/max:0);
  const sum=scaled.reduce((a,b)=>a+b,0);
  return scaled.map(w=>w/sum*100);
}
export function frequencyLevel(weight:number,share:number): 0|1|2|3|4 {
  return weight<=0 ? 0 : share<5 ? 1 : share<15 ? 2 : share<35 ? 3 : 4;
}
export const sliderMaximum=(rows:{weight:number}[])=>Math.max(1000,...rows.map(r=>Number.isFinite(r.weight)?r.weight:0));
export const cooldownPresets=[0,10,30,60,300] as const;
