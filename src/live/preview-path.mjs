const fail = (statusCode,message) => Object.assign(new Error(message),{statusCode});
export function designSystemPreviewPath(manifest = {}) {
  const entry=manifest.artifact?.entry || manifest.viewer?.entry || manifest.artifactEntry || 'index.html';
  if(typeof entry!=='string' || entry.length>500 || /[\\\x00-\x1f\x7f?#%:]/.test(entry) || entry.split('/').some(part=>!part || part==='.' || part==='..'))throw fail(400,'Invalid Design System Preview entry');
  return `/${entry.split('/').map(encodeURIComponent).join('/')}`.replace(/\/index\.html$/,'/');
}
