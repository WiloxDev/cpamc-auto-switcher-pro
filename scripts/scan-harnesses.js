#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const pluginDir = path.join(home, 'services', 'cliproxy', 'plugins');
const harnessesDir = path.join(pluginDir, '.harnesses');
fs.mkdirSync(harnessesDir, { recursive: true });

function parseMarkdownMetadata(filePath, defaultId) {
  let displayName = defaultId;
  let description = 'Agente detectado en disco';
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').slice(0, 35);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('# ') && displayName === defaultId) {
        displayName = line.replace(/^#\s*/, '').trim();
      } else if (line.toLowerCase().startsWith('description:')) {
        const desc = line.replace(/^description:\s*/i, '').trim().replace(/^["'`]|["'`]$/g, '');
        if (desc) description = desc;
      }
    }
  } catch {}
  return { displayName, description };
}

function deriveRole(agentId) {
  const l = agentId.toLowerCase();
  if (l.includes('explore') || l.includes('discover') || l.includes('search')) return 'discovery';
  if (l.includes('plan')) return 'planning';
  if (l.includes('apply') || l.includes('worker') || l.includes('fix')) return 'apply';
  if (l.includes('verify') || l.includes('test')) return 'verify';
  if (l.includes('review') || l.includes('judge') || l.includes('audit')) return 'review';
  if (l.includes('research') || l.includes('news')) return 'research';
  return 'general';
}

function scanHostHarnesses() {
  const detectedHarnesses = [];

  // 1. Gentle-Shell CLI
  const gentleAgentDir = path.join(home, '.gentle-shell', 'agent');
  const gentleAgentsPath = path.join(gentleAgentDir, 'agents');
  const gentleSubagentsPath = path.join(gentleAgentDir, 'subagents');

  // Solo se detecta si existe físicamente ~/.gentle-shell/agent/agents o ~/.gentle-shell/agent
  const hasGentleAgents = fs.existsSync(gentleAgentsPath) && fs.readdirSync(gentleAgentsPath).some(f => f.endsWith('.md'));
  const hasGentleSubagents = fs.existsSync(gentleSubagentsPath) && fs.readdirSync(gentleSubagentsPath).some(f => f.endsWith('.md'));

  if (hasGentleAgents || hasGentleSubagents || fs.existsSync(gentleAgentDir)) {
    const agents = [];

    // Orchestrator de Gentle-Shell
    agents.push({
      agent_id: 'orchestrator',
      display_name: '👑 ORQUESTADOR GENTLE-SHELL',
      role_type: 'orchestrator',
      is_orchestrator: true,
      description: 'Cerebro senior interactivo de Gentle-Shell CLI con streaming nativo',
      default_primary: 'Pool-04-claude',
      default_fallback: 'Pool-01-gemini',
      default_thinking: 'high',
      concurrency: 1,
    });

    const seenIds = new Set(['orchestrator']);
    const scanDirs = [gentleAgentsPath, gentleSubagentsPath].filter(d => fs.existsSync(d));

    // Si no tiene agentes instalados localmente en su home, solo ahí usamos los agentes de repo para aprovisionamiento inicial
    if (scanDirs.length === 0) {
      const repoAgents = path.join(__dirname, '..', 'agents');
      if (fs.existsSync(repoAgents)) scanDirs.push(repoAgents);
    }

    for (const d of scanDirs) {
      for (const f of fs.readdirSync(d).sort()) {
        if (f.endsWith('.md')) {
          const id = f.replace(/\.md$/, '');
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const meta = parseMarkdownMetadata(path.join(d, f), id);
          agents.push({
            agent_id: id,
            display_name: meta.displayName,
            role_type: deriveRole(id),
            is_orchestrator: false,
            description: meta.description,
            default_primary: id.includes('verify') ? 'Pool-02-gemini' : (id.includes('plan') || id.includes('worker') || id.includes('fix') ? 'Pool-04-claude' : 'Pool-01-gemini'),
            default_fallback: 'Pool-02-gemini',
            default_thinking: id.includes('verify') ? 'low' : 'medium',
            concurrency: (id.includes('explore') || id.includes('verify')) ? 2 : 1,
          });
        }
      }
    }

    detectedHarnesses.push({
      id: 'gentle_shell',
      name: 'Gentle-Shell CLI',
      icon: '📟',
      badge: '📟 Gentle-Shell Terminal CLI',
      config_path: '~/.gentle-shell/agent/profiles.json',
      subtitle: '⚡ Terminal CLI Soberana: Arnés independiente para desarrollo ágil en consola con streaming nativo.',
      agents,
    });
  }

  // 2. Gentle-PI (Solo si existe físicamente ~/.pi/gentle-ai con agentes markdown)
  const gentlePiAgentsDir = path.join(home, '.pi', 'gentle-ai', 'agents');
  const gentlePiSubagentsDir = path.join(home, '.pi', 'gentle-ai', 'subagents');
  const hasGentlePiMarkdown = (fs.existsSync(gentlePiAgentsDir) && fs.readdirSync(gentlePiAgentsDir).some(f => f.endsWith('.md'))) ||
                              (fs.existsSync(gentlePiSubagentsDir) && fs.readdirSync(gentlePiSubagentsDir).some(f => f.endsWith('.md')));

  if (hasGentlePiMarkdown) {
    const agents = [];
    agents.push({
      agent_id: 'orchestrator',
      display_name: '👑 ORQUESTADOR GENTLE-PI',
      role_type: 'orchestrator',
      is_orchestrator: true,
      description: 'Cerebro senior de Gentle-AI que atiende en OpenCode y suite Pi',
      default_primary: 'Pool-04-claude',
      default_fallback: 'Pool-01-gemini',
      default_thinking: 'high',
      concurrency: 1,
    });

    const seenIds = new Set(['orchestrator']);
    const scanDirs = [gentlePiAgentsDir, gentlePiSubagentsDir].filter(d => fs.existsSync(d));

    for (const d of scanDirs) {
      for (const f of fs.readdirSync(d).sort()) {
        if (f.endsWith('.md')) {
          const id = f.replace(/\.md$/, '');
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const meta = parseMarkdownMetadata(path.join(d, f), id);
          agents.push({
            agent_id: id,
            display_name: meta.displayName,
            role_type: deriveRole(id),
            is_orchestrator: false,
            description: meta.description,
            default_primary: id.includes('verify') ? 'Pool-02-gemini' : (id.includes('plan') || id.includes('worker') || id.includes('fix') ? 'Pool-04-claude' : 'Pool-01-gemini'),
            default_fallback: 'Pool-02-gemini',
            default_thinking: id.includes('verify') ? 'low' : 'medium',
            concurrency: (id.includes('explore') || id.includes('verify')) ? 2 : 1,
          });
        }
      }
    }

    detectedHarnesses.push({
      id: 'gentle_pi',
      name: 'Gentle-PI',
      icon: '🤖',
      badge: '🤖 Gentle-PI Suite',
      config_path: '~/.pi/gentle-ai/profiles.json',
      subtitle: '🤖 Entorno oficial Gentle-PI con suite de agentes y evaluadores de arquitectura (ODD/Judgment Day).',
      agents,
    });
  }

  const manifest = {
    version: '1.0.0',
    scanned_at_ms: Date.now(),
    detected_harnesses: detectedHarnesses,
  };

  const manifestPath = path.join(harnessesDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return { manifestPath, detectedHarnesses };
}

if (require.main === module) {
  const { manifestPath, detectedHarnesses } = scanHostHarnesses();
  console.log('Manifest written successfully to:', manifestPath);
  console.log('Harnesses count:', detectedHarnesses.length);
  for (const h of detectedHarnesses) {
    console.log(` - ${h.name} (${h.id}): ${h.agents.length} agentes`);
  }
}

module.exports = { scanHostHarnesses };
