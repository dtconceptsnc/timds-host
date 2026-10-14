// Cloudflare Containers instance sizes the host may select. Live sessions and
// publication containers each read their own TIMDS_*_INSTANCE_TYPE setting
// through this one list so an unknown value falls back instead of failing.
const instanceTypes=new Set(['standard-1','standard-2','standard-3','standard-4']);
export function containerInstanceType(value,fallback){return instanceTypes.has(value)?value:fallback;}
