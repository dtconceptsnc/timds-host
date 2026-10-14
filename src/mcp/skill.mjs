// The skill an agent keeps for a Design System on this host. The toolkit owns
// the text (skills/timds-hosted-design-system/SKILL.md, embedded by
// scripts/generate-hosted-skill.mjs); the host only fills in where it lives.
import { hostedSkillTemplate } from './hosted-skill-data.mjs';

const folder=systemId=>String(systemId||'').split('/').pop().replace(/[^a-z0-9-]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase();
export const skillName=system=>`timds-${folder(system.systemId)||'design-system'}`;
export function skillDocument({origin,system}){
  const name=skillName(system),studio=new URL('/studio/',origin);
  studio.hash=new URLSearchParams({source:system.id}).toString();
  const values={__SKILL_NAME__:name,__SYSTEM_NAME__:system.name||system.systemId,__SYSTEM_ID__:system.systemId,__HOST_ORIGIN__:origin,__MCP_URL__:`${origin}/api/timds/mcp`,__STUDIO_URL__:studio.href};
  const skill=hostedSkillTemplate.replace(/__[A-Z_]+__/g,placeholder=>{if(!(placeholder in values))throw new Error(`Unfilled skill placeholder ${placeholder}`);return values[placeholder];});
  return {apiVersion:1,name,path:`${name}/SKILL.md`,skill};
}
