const EN = `a about above after again against all almost also although always am among an and another any
are around as at back be became because become becomes been before being below between both but by
can cannot could did do does doing done down during each either else enough etc even ever every few
for from further get gets got had has have having he her here hers herself him himself his how however
i if in into is it its itself just keep last least less let like likely made make makes many may me
might more most mostly much must my myself near need neither never new next no nor not now of off often
on once one only onto or other others ought our ours ourselves out over own per perhaps rather really
same seem seemed seems several she should since so some something still such than that the their theirs
them themselves then there these they this those though through thus to too toward under until up upon
us use used using very via was way we well were what whatever when whenever where whether which while
who whoever whom whose why will with within without would yes yet you your yours yourself yourselves
re ve ll s t d m don doesn didn isn aren wasn weren won wouldn couldn shouldn here's it's that's there's
things thing lot lots way ways really actually basically simply just also already another whole`
  .split(/\s+/)
  .filter(Boolean);

export const STOPWORDS: ReadonlySet<string> = new Set(EN);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}
