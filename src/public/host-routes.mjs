// Deployment routing is explicit and independently checked against the imported
// source metadata. A deleted/unlisted system has no route and remains a 404.
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hostname=value=>typeof value==='string'&&value.length<=253&&value===value.toLowerCase()&&value.includes('.')&&value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
export function legacySourceRoots(value){
  if(value?.schemaVersion!==1||value.behavior!=='portal-public-roots-v1'||!Array.isArray(value.hosts)||!value.hosts.length||value.hosts.length>16||new Set(value.hosts).size!==value.hosts.length||value.hosts.some(host=>!hostname(host)))throw new Error('Invalid legacy public roots');
  return value.hosts;
}
export function legacyHostRoutes(value='{}'){
  const parsed=typeof value==='string'?JSON.parse(value):value;
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).length>1000)throw new Error('Invalid legacy host routes');
  for(const [host,id]of Object.entries(parsed))if(!hostname(host)||!UUID.test(id||''))throw new Error('Invalid legacy host route');
  return parsed;
}
