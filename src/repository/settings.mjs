// Retention is an opt-in measurement control. Only ordinary, fully drained
// operations share a source sandbox; publication checkouts stay isolated.
export const reusableRepositoryMethods=new Set(['readSource','start','snapshot','stale','submit','update','mergeIntoDraft','history','close','merge']);
export function repositoryRetentionSeconds(env){const seconds=Number(env?.TIMDS_REPOSITORY_RETENTION_SECONDS||0);return Number.isFinite(seconds)&&seconds>0?Math.min(300,Math.floor(seconds)):0;}
export function repositoryPhases(value){return Object.fromEntries(['repository-prepare','repository-boot','repository-git','repository-complete','repository-files'].filter(stage=>Number.isFinite(value?.[stage])&&value[stage]>=0).map(stage=>[stage,Math.round(value[stage])]));}
