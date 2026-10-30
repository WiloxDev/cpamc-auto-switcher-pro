import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  saveAuthFilePrefixes,
  listModels,
  listPools,
  patchAuthFileExclusions,
  classifyAuthAccount,
  deleteAuthFile,
  buildManagedPoolCards,
  savePool,
  dissolvePool,
  resolveInheritedCardModels,
  CANONICAL_PROVIDER_MODELS,
  extractPoolNumber,
  sortPoolsByNumber,
  getAuthFileModels,
} from '../api/managementClient';
import '../GroupManager.css';
import CommunityNoticeModal, {
  STORAGE_KEY_SUPPORTER,
  STORAGE_KEY_DISMISSED,
} from './CommunityNoticeModal';

// Rol de cuota de un pool del registro (coherente con targetFamilyRole / buildManagedPoolCards):
// gemini_pure → 'gemini'; gemini_sonnet/gemini_opus/gemini_claude/claude → 'claude'; codex → 'codex'
const poolFamilyRole = (family) => {
  const f = (family || '').trim();
  if (!f) return null;
  if (f === 'gemini_pure' || f.startsWith('gemini_pure')) return 'gemini';
  if (f === 'codex' || f.startsWith('codex')) return 'codex';
  if (f === 'gemini_sonnet' || f === 'gemini_opus' || f === 'gemini_claude' || f === 'claude') return 'claude';
  return f;
};

// Familias principales soportadas por la convención de cuota del switcher (internal/quota/quota.go)
const MODEL_FAMILIES = {
  gemini: {
    label: 'Google Gemini',
    icon: '✨',
    provider: 'antigravity',
    hasSubtypes: true,
    subtypes: {
      pure: {
        key: 'pure',
        label: 'Gemini Fleet',
        icon: '🔷',
        hintPrefix: 'agy',
        quota: 'Gemini Models',
        targetPatterns: ['gemini'],
        note: 'Cuentas de Google Gemini.',
      },
      sonnet: {
        key: 'sonnet',
        label: 'Claude Sonnet',
        icon: '🔶',
        hintPrefix: 'agy_son',
        quota: 'Claude and GPT models',
        targetPatterns: ['sonnet'],
        note: 'Pool dedicado para código y tareas ágiles con claude-sonnet-4-6 y claude-sonnet-5-5-high.',
      },
      opus: {
        key: 'opus',
        label: 'Claude Opus',
        icon: '🟣',
        hintPrefix: 'agy_opus',
        quota: 'Claude and GPT models',
        targetPatterns: ['opus'],
        note: 'Pool de razonamiento profundo con claude-opus-4-6-thinking y claude-opus-5-5-high.',
      },
      claude: {
        key: 'claude',
        label: 'Antigravity Dual',
        icon: '🎭',
        hintPrefix: 'agy_clau',
        quota: 'Claude and GPT models',
        targetPatterns: ['claude', 'gpt'],
        note: 'Pool dual que rota tanto Sonnet como Opus bajo la misma cuota.',
      },
    },
  },
  claude: {
    label: 'Anthropic Claude',
    icon: '🤖',
    hintPrefix: 'clau',
    provider: 'claude',
    quota: 'Claude and GPT models',
    note: 'Cuentas directas oficiales de Anthropic.',
  },
  codex: {
    label: 'OpenAI Codex',
    icon: '🧩',
    hintPrefix: 'codex',
    provider: 'codex',
    quota: 'Codex',
    note: 'Cuentas individuales de Codex / OpenAI.',
  },
};

// Metadatos de proveedores dinámicos (OmniAuth Pro / ecosistema CPAMC)
const OMNIAUTH_PROVIDER_META = {
  deepseek: {
    label: 'DeepSeek',
    icon: '🐋',
    hintPrefix: 'deepseek',
    quota: 'DeepSeek Chat & Reasoner',
    note: 'Cuentas oficiales o compatibles de DeepSeek.',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  nvidia: {
    label: 'NVIDIA NIM',
    icon: '🟢',
    hintPrefix: 'nvidia',
    quota: 'NVIDIA NIM Cluster',
    note: 'Cuentas de aceleración NVIDIA NIM.',
    models: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1', 'nvidia/llama-3.1-nemotron-70b-instruct'],
  },
  groq: {
    label: 'Groq',
    icon: '⚡',
    hintPrefix: 'groq',
    quota: 'Groq Ultra-Fast LPU',
    note: 'Cuentas de aceleración Groq LPU.',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  cerebras: {
    label: 'Cerebras',
    icon: '🏎️',
    hintPrefix: 'cerebras',
    quota: 'Cerebras Wafer-Scale',
    note: 'Cuentas de aceleración Cerebras Wafer-Scale Engine.',
    models: ['llama-3.3-70b', 'llama3.1-8b'],
  },
  mistral: {
    label: 'Mistral AI',
    icon: '🌪️',
    hintPrefix: 'mistral',
    quota: 'Mistral La Plateforme',
    note: 'Cuentas oficiales de Mistral AI.',
    models: ['mistral-large-latest', 'codestral-latest'],
  },
  typesafe: {
    label: 'TypeSafe AI',
    icon: '🛡️',
    hintPrefix: 'typesafe',
    quota: 'TypeSafe AI Router',
    note: 'Cuentas protegidas de TypeSafe AI Router.',
    models: ['deepseek-chat', 'deepseek-r1'],
  },
  vercel: {
    label: 'Vercel AI Gateway',
    icon: '▲',
    hintPrefix: 'vercel',
    quota: 'Vercel AI Gateway',
    note: 'Cuentas enrutadas vía Vercel AI Gateway.',
    models: ['anthropic/claude-3-7-sonnet', 'openai/gpt-4o'],
  },
  nan: {
    label: 'NaN Builders',
    icon: '🧬',
    hintPrefix: 'nan',
    quota: 'NaN Builders Fleet',
    note: 'Cuentas del clúster NaN Builders.',
    models: ['deepseek-v4-flash', 'glm-5.3-flash', 'mimo-v2.6-flash'],
  },
  opencode: {
    label: 'OpenCode Go',
    icon: '💻',
    hintPrefix: 'opencode',
    quota: 'OpenCode Catalogs',
    note: 'Cuentas de catálogo dinámico OpenCode.',
    models: ['deepseek-chat', 'gemini-2.5-flash'],
  },
  'openai-compat': {
    label: 'OpenAI Compatible',
    icon: '🌐',
    hintPrefix: 'custom',
    quota: 'OpenAI Compatible Endpoint',
    note: 'Endpoints compatibles con especificación OpenAI.',
    models: ['default'],
  },
};

// Patrones de nombre por familia objetivo: se usan para liberar modelos del
// origen al virtualizar aunque el catálogo no los liste (p.ej. excluidos).
const FAMILY_TARGET_PATTERNS = {
  gemini_pure: ['gemini'],
  gemini_sonnet: ['sonnet'],
  gemini_opus: ['opus'],
  gemini_claude: ['claude', 'gpt'],
  claude: ['claude', 'gpt'],
  codex: ['codex'],
};

// Determina si un prefijo es descendiente estricto de un pool base:
// 'agy' -> 'agy_1', 'agy_2' (SI), pero 'agy_clau' (NO, porque su sufijo es alfabético).
function isPoolDescendant(poolBase, prefix) {
  const p = (prefix || '').trim();
  const b = (poolBase || '').trim();
  if (!p || !b) return false;
  if (p === b) return true;
  if (!p.startsWith(`${b}_`)) return false;
  const suffix = p.slice(b.length + 1);
  return /^\d+/.test(suffix);
}

// Filtra rutas modelo por familia del pool según su convención de prefijo:
// agy_clau* / clau* / son* -> solo claude/gpt
// agy* / g* -> solo gemini
// codex* -> solo codex
function matchesFamilyModel(base, modelId, exclude55 = false) {
  const id = String(modelId || '').toLowerCase();
  const b = String(base || '').toLowerCase();
  if (exclude55 && (id.includes('5-5') || id.includes('5.5'))) {
    return false;
  }
  if (b.startsWith('agy_opus')) {
    return id.includes('opus');
  }
  if (b.startsWith('agy_son')) {
    return id.includes('sonnet');
  }
  if (b.startsWith('agy_clau') || b.startsWith('clau') || b.startsWith('son')) {
    return id.includes('claude') || /^gpt/.test(id.replace(/^[a-z0-9_-]+\//, ''));
  }
  if (b.startsWith('agy') || b.startsWith('g')) {
    return id.includes('gemini');
  }
  if (b.startsWith('codex')) {
    return (
      id.includes('codex') ||
      id.includes('astra') ||
      id.includes('sol') ||
      id.includes('terra') ||
      id.includes('luna') ||
      id.includes('chatgpt') ||
      /^gpt/.test(id.replace(/^[a-z0-9_-]+\//, '')) ||
      id.includes('o1') ||
      id.includes('o3') ||
      id.includes('o4')
    );
  }
  return true;
}

// Obtiene el identificador de proveedor canónico de un nodo de forma agnóstica
export function getNodeProvider(node) {
  if (!node) return '';
  const prov = (node.data?.provider || node.data?.accountType || '').toLowerCase().trim();
  const fn = (node.data?.fileName || node.name || node.id || '').toLowerCase().trim();
  const p = (node.data?.prefix || '').toLowerCase().trim();

  // 1. Proveedores específicos con firma estricta en nombre de archivo, prefijo o tipo
  if (prov === 'codex' || fn.startsWith('codex') || p.startsWith('codex')) {
    return 'codex';
  }
  if (prov === 'claude' || fn.startsWith('claude') || fn.startsWith('clau-') || p.startsWith('clau')) {
    return 'claude';
  }
  if (prov === 'antigravity' || fn.startsWith('antigravity') || p.startsWith('agy') || (p.startsWith('g') && !p.startsWith('groq'))) {
    return 'antigravity';
  }

  // 2. OmniAuth Pro providers (nvidia/nim, nan, opencode, deepseek, groq, etc.)
  for (const [provKey, meta] of Object.entries(OMNIAUTH_PROVIDER_META)) {
    if (
      prov === provKey ||
      prov.includes(provKey) ||
      fn.startsWith(`${meta.hintPrefix}-`) ||
      fn.startsWith(`${provKey}-`) ||
      p.startsWith(meta.hintPrefix) ||
      (provKey === 'nvidia' && (p.startsWith('nim') || fn.startsWith('nim-') || fn.includes('nvidia-nim') || fn.includes('nim-') || p === 'nim'))
    ) {
      return provKey;
    }
  }

  return prov || 'unknown';
}

// Obtiene el identificador de proveedor canónico de un pool a partir de sus cuentas reales o prefijo base
export function getPoolProvider(pool) {
  if (!pool) return '';

  // 1. Las cuentas físicas reales mandan sobre cualquier metadato heredado
  const sampleNode = pool.root || (pool.reserves && pool.reserves[0]?.node);
  if (sampleNode) {
    const prov = getNodeProvider(sampleNode);
    if (prov && prov !== 'unknown') return prov;
  }

  // 2. Si no hay nodo resuelto, el prefijo base del pool define el proveedor
  const bp = (pool.basePrefix || '').toLowerCase().trim();
  if (bp.startsWith('agy') || bp.startsWith('g')) return 'antigravity';
  if (bp.startsWith('clau')) return 'claude';
  if (bp.startsWith('codex')) return 'codex';
  if (bp === 'nim' || bp.startsWith('nim')) return 'nvidia';
  for (const [provKey, meta] of Object.entries(OMNIAUTH_PROVIDER_META)) {
    if (bp.startsWith(meta.hintPrefix)) return provKey;
  }

  // 3. Fallback a pool.family si no hubo coincidencia previa
  if (pool.family) {
    const fam = pool.family.toLowerCase();
    if (fam.startsWith('gemini')) return 'antigravity';
    if (fam === 'claude') return 'claude';
    if (fam === 'codex') return 'codex';
    if (fam === 'nim' || fam === 'nvidia') return 'nvidia';
    if (OMNIAUTH_PROVIDER_META[fam]) return fam;
  }

  return 'unknown';
}

// Sugiere el siguiente prefijo base libre sin colisiones para N grupos:
// agy -> si agy existe, sugiere agy2, agy3...
// agy_clau -> si agy_clau existe, sugiere agy_clau2, agy_clau3...
function suggestNextBasePrefix(nodes, hint) {
  const existing = new Set(
    nodes.map((n) => (n?.data?.prefix || '').trim()).filter(Boolean)
  );
  if (!existing.has(hint)) return hint;
  let idx = 2;
  while (existing.has(`${hint}${idx}`)) idx++;
  return `${hint}${idx}`;
}

// Próximo número de reserva sin colisión contra TODOS los prefijos existentes
// (nodes) más los ya asignados en la transacción en curso (extraAssigned).
function nextReserveNumber(nodes, base, extraAssigned) {
  const existing = new Set(
    nodes.map((n) => (n?.data?.prefix || '').trim()).filter(Boolean)
  );
  if (extraAssigned) {
    extraAssigned.forEach((p) => existing.add(p));
  }
  let n = 1;
  while (existing.has(`${base}_${n}`)) n++;
  return n;
}

/**
 * GroupManager Component
 * Dedicated full-screen manager for structuring new pools and dissolving existing ones.
 */
export default function GroupManager({
  nodes = [],
  edges = [],
  onReloadRequested,
  onSwitchTab,
}) {
  const [activeTab, setActiveTab] = useState('create'); // 'create' | 'dissolve'
  const [groupBasePrefix, setGroupBasePrefix] = useState('');
  const [selectedActiveNodeId, setSelectedActiveNodeId] = useState('');
  const [selectedReserveNodeIds, setSelectedReserveNodeIds] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [successFeedback, setSuccessFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [family, setFamily] = useState(null); // 'gemini' | 'claude' | 'codex' | null (libre)
  const [geminiSubtype, setGeminiSubtype] = useState('pure'); // 'pure' (agy) | 'claude' (agy_clau)
  const [excludeVersion55, setExcludeVersion55] = useState(false);
  const [selectedSpecialistModel, setSelectedSpecialistModel] = useState('');
  const [saveReport, setSaveReport] = useState(null); // { base, successful, failed }
  const [modelRoutes, setModelRoutes] = useState(null); // { base, routes: [] }
  const [copiedRoute, setCopiedRoute] = useState('');
  const [isNoticeOpen, setIsNoticeOpen] = useState(false);
  const pendingCreationRef = useRef(false);
  // [registeredPools] Pools registrados en el plugin PoolRegistry (fuente única de verdad).
  // Se resincroniza en cada reload de nodos (tras crear/disolver un pool).
  const [registeredPools, setRegisteredPools] = useState([]);
  const [catalogModels, setCatalogModels] = useState([]);
  const [cardAdoptSelections, setCardAdoptSelections] = useState({});
  const [selectedAuthModels, setSelectedAuthModels] = useState([]);
  const feedbackTimeoutRef = useRef(null);

  // Sincronizar dinámicamente los modelos nativos de la credencial física seleccionada (CPAMC auth-file)
  useEffect(() => {
    if (!selectedActiveNodeId) {
      setSelectedAuthModels([]);
      return;
    }
    const activeNode = nodes.find((n) => n.id === selectedActiveNodeId);
    const fileName = activeNode?.data?.fileName || activeNode?.name || activeNode?.id;
    if (!fileName || !fileName.endsWith('.json')) {
      setSelectedAuthModels([]);
      return;
    }
    let cancelled = false;
    getAuthFileModels(fileName)
      .then((models) => {
        if (!cancelled && Array.isArray(models)) {
          setSelectedAuthModels(models);
        }
      })
      .catch(() => {
        if (!cancelled) setSelectedAuthModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedActiveNodeId, nodes]);

  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        clearTimeout(feedbackTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    listModels()
      .then((res) => {
        if (mounted && Array.isArray(res?.models)) {
          setCatalogModels(res.models);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  // Evalúa si las cuentas de Antigravity conectadas o el catálogo soportan modelos Claude
  const hasClaudeInAntigravity = useMemo(() => {
    const hasExistingClaudePrefixes = nodes.some((n) => {
      const p = (n.data?.prefix || '').toLowerCase();
      return p.startsWith('agy_son') || p.startsWith('agy_opus') || p.startsWith('agy_clau');
    });
    if (hasExistingClaudePrefixes) return true;

    if (!catalogModels || catalogModels.length === 0) return true;

    return catalogModels.some((m) => {
      const lower = String(m || '').toLowerCase();
      return lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus');
    });
  }, [nodes, catalogModels]);

  useEffect(() => {
    let cancelled = false;
    listPools()
      .then((res) => {
        if (!cancelled) setRegisteredPools(sortPoolsByNumber(Array.isArray(res?.pools) ? res.pools : []));
      })
      .catch(() => {
        // Registro no disponible: degradar a pools derivados de prefijos en disco
        if (!cancelled) setRegisteredPools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [nodes]);

  // Archivos miembros de pools registrados (cualquier familia) — para freeNodes
  const registryMemberFileNames = useMemo(() => {
    const members = new Set();
    registeredPools.forEach((pool) => {
      if (pool.leader_auth) members.add(pool.leader_auth);
      if (Array.isArray(pool.members)) pool.members.forEach((auth) => members.add(auth));
      (Array.isArray(pool.reserves) ? pool.reserves : []).forEach((auth) => members.add(auth));
    });
    return members;
  }, [registeredPools]);

  // [2N] Miembros de pools registrados agrupados por rol de cuota: una cuenta física
  // puede servir a 'gemini' Y a 'claude' a la vez, pero solo a UN pool por rol
  const registryMembersByRole = useMemo(() => {
    const byRole = new Map();
    registeredPools.forEach((pool) => {
      const role = poolFamilyRole(pool.family);
      if (!role) return;
      if (!byRole.has(role)) byRole.set(role, new Set());
      const members = byRole.get(role);
      if (pool.leader_auth) members.add(pool.leader_auth);
      (Array.isArray(pool.reserves) ? pool.reserves : []).forEach((auth) => members.add(auth));
    });
    return byRole;
  }, [registeredPools]);

  // Identificar cuentas verdaderamente libres: sin prefijo asignado o huérfanas,
  // y que NO sean miembros de un pool registrado (el registro es la verdad autoritativa)
  const freeNodes = useMemo(() => {
    return nodes.filter((n) => {
      const fileName = n.data?.fileName || n.name || n.id || '';
      if (registryMemberFileNames.has(fileName)) return false;
      const pref = (n.data?.prefix || '').trim();
      return pref === '' || pref.startsWith('unlinked_');
    });
  }, [nodes, registryMemberFileNames]);

  // Helper para verificar si un proveedor/familia tiene cuentas activas en nodes
  const checkFamilyHasAccounts = useCallback((famProvider, hintPrefix) => {
    return Array.isArray(nodes) && nodes.some((n) => {
      const prov = (n.data?.provider || n.data?.accountType || '').toLowerCase();
      const p = (n.data?.prefix || '').toLowerCase();
      const fileName = (n.data?.fileName || n.name || n.id || '').toLowerCase();
      if (famProvider === 'antigravity') {
        return prov === 'antigravity' || fileName.startsWith('antigravity');
      }
      if (famProvider === 'claude') {
        return prov === 'claude' || fileName.startsWith('claude') || fileName.startsWith('clau-') || p.startsWith('clau');
      }
      return (
        prov === famProvider ||
        prov.includes(famProvider) ||
        (hintPrefix && p.startsWith(hintPrefix)) ||
        (hintPrefix && fileName.startsWith(`${hintPrefix}-`))
      );
    });
  }, [nodes]);

  // Familias de modelos totales (Dinámicas según cuentas logueadas en CPAMC nativo + Proveedores de OmniAuth Pro)
  const allModelFamilies = useMemo(() => {
    const families = {};
    if (!Array.isArray(nodes) || nodes.length === 0) return families;

    // 1. Familias principales (Gemini, Claude, Codex) SOLO si tienen cuentas logueadas en CPAMC nativo
    for (const [key, fam] of Object.entries(MODEL_FAMILIES)) {
      if (checkFamilyHasAccounts(fam.provider, fam.hintPrefix)) {
        families[key] = { ...fam };
      }
    }

    // 2. Detectar qué proveedores de OmniAuth Pro existen en los nodos cargados
    const detectedProviders = new Set();
    nodes.forEach((n) => {
      const p = (n.data?.provider || n.data?.accountType || '').toLowerCase().trim();
      const fn = (n.data?.fileName || n.name || n.id || '').toLowerCase().trim();

      // Mapear proveedor o prefijo de nombre de archivo a OMNIAUTH_PROVIDER_META
      for (const [provKey, meta] of Object.entries(OMNIAUTH_PROVIDER_META)) {
        if (
          p === provKey ||
          p.includes(provKey) ||
          fn.startsWith(`${meta.hintPrefix}-`) ||
          fn.startsWith(`${provKey}-`)
        ) {
          detectedProviders.add(provKey);
        }
      }
    });

    // Agregar al final de la barra preservando Gemini, Claude y Codex primero si están presentes
    detectedProviders.forEach((provKey) => {
      const meta = OMNIAUTH_PROVIDER_META[provKey];
      if (meta && !families[provKey]) {
        families[provKey] = {
          key: provKey,
          label: meta.label,
          icon: meta.icon,
          hintPrefix: meta.hintPrefix,
          provider: provKey,
          quota: meta.quota,
          note: meta.note,
          isOmniAuthPro: true,
          models: meta.models,
        };
      }
    });

    return families;
  }, [nodes, checkFamilyHasAccounts]);

  // Si la familia seleccionada ya no existe en las familias activas, resetear selección
  useEffect(() => {
    if (family && !allModelFamilies[family]) {
      setFamily(null);
    }
  }, [family, allModelFamilies]);

  // Resolución de familia efectiva (gestiona la jerarquía de sub-tipos de Gemini)
  const effectiveFamily = useMemo(() => {
    if (!family) return null;
    if (family === 'gemini') {
      const sub = MODEL_FAMILIES.gemini.subtypes[geminiSubtype] || MODEL_FAMILIES.gemini.subtypes.pure;
      return {
        key: `gemini_${geminiSubtype}`,
        label: sub.label,
        hintPrefix: sub.hintPrefix,
        provider: 'antigravity',
        quota: sub.quota,
        note: sub.note,
      };
    }
    const fam = allModelFamilies[family] || MODEL_FAMILIES[family];
    if (!fam) return null;
    return {
      key: family,
      label: fam.label,
      hintPrefix: fam.hintPrefix,
      provider: fam.provider || family,
      quota: fam.quota || `${fam.label} API`,
      note: fam.note || `Cuentas de ${fam.label}.`,
      isOmniAuthPro: fam.isOmniAuthPro || false,
      models: fam.models || [],
    };
  }, [family, geminiSubtype, allModelFamilies]);

  const isGeminiPackageFamily = !!effectiveFamily && (
    effectiveFamily.key.startsWith('gemini_')
  );

  // 1. Managed pool cards abstraction (N -> 2N scalable model sincronizado con Auto Auth Files)
  const managedCards = useMemo(() => buildManagedPoolCards(nodes), [nodes]);

  // Rol de familia objetivo según la selección (gemini vs claude vs codex)
  const targetFamilyRole = useMemo(() => {
    if (!effectiveFamily) return null;
    if (effectiveFamily.key === 'gemini_pure') return 'gemini';
    if (
      effectiveFamily.key === 'gemini_sonnet' ||
      effectiveFamily.key === 'gemini_opus' ||
      effectiveFamily.key === 'gemini_claude' ||
      effectiveFamily.key === 'claude'
    ) {
      return 'claude';
    }
    if (effectiveFamily.key === 'codex' || effectiveFamily.provider === 'codex') {
      return 'codex';
    }
    if (effectiveFamily.isOmniAuthPro || effectiveFamily.provider !== 'antigravity') {
      return effectiveFamily.provider;
    }
    return null;
  }, [effectiveFamily]);

// Helper para extraer dinámicamente versiones numéricas de cualquier modelo (SemVer / float)
// Ejemplos: "gpt-6.1" -> 6.1, "claude-3-7-sonnet" -> 3.7, "gemini-3.8-flash-high" -> 3.8, "glm-5.3" -> 5.3
function extractModelVersion(modelName) {
  if (typeof modelName !== 'string') return 0;
  const clean = modelName.toLowerCase();

  // 1. Número con punto: gpt-6.1, gpt-5.6, gemini-3.8, glm-5.3, etc.
  const dotMatch = clean.match(/(?:gpt-|gemini-|claude-|v|glm-|mimo-v|qwen|kimi-k|grok-)?(\d+)\.(\d+)/);
  if (dotMatch) {
    return parseFloat(`${dotMatch[1]}.${dotMatch[2]}`);
  }
  // 2. Formato con guiones: claude-3-7 -> 3.7, claude-3-5 -> 3.5, sonnet-5-5 -> 5.5, sonnet-4-6 -> 4.6
  const dashMatch = clean.match(/(?:claude-|sonnet-|opus-)(\d+)-(\d+)/);
  if (dashMatch) {
    return parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);
  }
  // 3. Versión mayor única: gpt-6 -> 6.0, gpt-5 -> 5.0, o3 -> 3.0, o1 -> 1.0, gemini-3 -> 3.0
  const singleMatch = clean.match(/(?:gpt-|gemini-|claude-|o|glm-)(\d+)/);
  if (singleMatch) {
    return parseFloat(singleMatch[1]);
  }
  return 0;
}

// Ordenamiento dinámico y universal por versión más avanzada (flagship primero)
function sortModelsByFamilyAndVersion(models, familyRole, isCodex, isGemini) {
  const canonicalList = CANONICAL_PROVIDER_MODELS[familyRole] || [];
  const canonicalMap = new Map();
  canonicalList.forEach((m, idx) => {
    canonicalMap.set(m.toLowerCase(), idx);
  });

  return [...models].sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aIdx = canonicalMap.has(aLower) ? canonicalMap.get(aLower) : -1;
    const bIdx = canonicalMap.has(bLower) ? canonicalMap.get(bLower) : -1;

    // Si ambos están en la lista canónica curada, respetar el orden de prioridad canónico (flagship primero)
    if (aIdx !== -1 && bIdx !== -1) {
      return aIdx - bIdx;
    }
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;

    // Si no están en la lista canónica, ordenar por versión numérica (SemVer más alto primero)
    const vA = extractModelVersion(a);
    const vB = extractModelVersion(b);
    if (vB !== vA) {
      return vB - vA; // Versión más alta primero (6.1 > 6.0 > 5.6..., 3.8 > 3.7..., 3.7 > 3.5...)
    }

    if (isCodex) {
      const getCodexSubPriority = (name) => {
        const lower = name.toLowerCase();
        if (lower.includes('6.1')) return 610;
        if (lower.includes('astra')) return 600;
        if (lower.includes('sol')) return 590;
        if (lower.includes('luna')) return 580;
        if (lower.includes('terra')) return 570;
        return 0;
      };
      const pDiff = getCodexSubPriority(b) - getCodexSubPriority(a);
      if (pDiff !== 0) return pDiff;
    }

    if (isGemini) {
      const a38 = a.includes('3.8');
      const b38 = b.includes('3.8');
      if (a38 && !b38) return -1;
      if (!a38 && b38) return 1;
    }

    return a.localeCompare(b);
  });
}

  // Modelos candidatos disponibles para el pool según la familia efectiva seleccionada
  const availableSpecialistModels = useMemo(() => {
    if (!effectiveFamily) return [];

    // Verificación de existencia real: ¿Existen cuentas vinculadas en el sistema para esta familia?
    const famProvider = effectiveFamily.provider;
    const familyAccountsExist = nodes.some((n) => {
      const prov = (n.data?.provider || n.data?.accountType || '').toLowerCase();
      const p = (n.data?.prefix || '').toLowerCase();
      const fileName = (n.data?.fileName || n.name || n.id || '').toLowerCase();
      if (famProvider === 'antigravity') {
        return prov === 'antigravity' || fileName.startsWith('antigravity');
      }
      if (famProvider === 'claude') {
        // Cuentas directas oficiales Anthropic (CPAMC nativo o auth-files con clau*)
        // NUNCA confundir con el paquete de Google Antigravity
        return (
          prov === 'claude' ||
          fileName.startsWith('claude') ||
          fileName.startsWith('clau-') ||
          p.startsWith('clau')
        );
      }
      return (
        prov === famProvider ||
        prov.includes(famProvider) ||
        p.startsWith(effectiveFamily.hintPrefix) ||
        fileName.startsWith(`${effectiveFamily.hintPrefix}-`)
      );
    });

    // CERO HARDCODING: si no hay cuentas logeadas de esta familia, no inventar modelos
    if (!familyAccountsExist) {
      return [];
    }

    // 1. Si la cuenta física seleccionada tiene modelos nativos inspeccionados vía getAuthFileModels:
    if (selectedAuthModels.length > 0) {
      let models = [...selectedAuthModels];
      if (excludeVersion55) {
        models = models.filter((m) => !m.includes('5-5') && !m.includes('5.5'));
      }
      const isGem = (targetFamilyRole || '') === 'gemini';
      const isCod = (targetFamilyRole || '') === 'codex';
      return sortModelsByFamilyAndVersion(models, targetFamilyRole, isCod, isGem);
    }

    // 2. Extraer dinámicamente de los modelos activos del catálogo en tiempo real
    const sourceModels = Array.isArray(catalogModels) && catalogModels.length > 0
      ? catalogModels
      : [];
    const dummyCard = {
      familyRole: targetFamilyRole || 'gemini',
      assignedPrefix: effectiveFamily.hintPrefix,
    };
    let models = resolveInheritedCardModels(dummyCard, sourceModels);

    // Solo si existen cuentas logeadas de esta familia y el catálogo upstream aún no cargó:
    if (models.length === 0) {
      if (effectiveFamily.key === 'gemini_pure') {
        models = [
          'gemini-3.8-flash-high',
          'gemini-3.7-flash-high',
          'gemini-3.6-flash-high',
          'gemini-3.5-flash-lite',
          'gemini-3.1-flash-lite',
          'gemini-3-flash',
        ];
      } else if (effectiveFamily.key === 'gemini_sonnet') {
        models = ['claude-sonnet-4-6', 'claude-sonnet-5-5-high'];
      } else if (effectiveFamily.key === 'gemini_opus') {
        models = ['claude-opus-4-6-thinking', 'claude-opus-5-5-high'];
      } else if (effectiveFamily.key === 'gemini_claude') {
        models = ['claude-sonnet-4-6', 'claude-opus-4-6-thinking'];
      } else if (effectiveFamily.isOmniAuthPro && CANONICAL_PROVIDER_MODELS[targetFamilyRole]) {
        models = [...CANONICAL_PROVIDER_MODELS[targetFamilyRole]];
      }
    }

    if (excludeVersion55) {
      models = models.filter((m) => !m.includes('5-5') && !m.includes('5.5'));
    }

    const isGemini = (targetFamilyRole || '') === 'gemini';
    const isCodex = (targetFamilyRole || '') === 'codex';
    return sortModelsByFamilyAndVersion(models, targetFamilyRole, isCodex, isGemini);
  }, [effectiveFamily, nodes, catalogModels, selectedAuthModels, targetFamilyRole, excludeVersion55]);

  // Actualizar el modelo especialista predeterminado cuando cambie la familia o subtipo:
  // no autoseleccionar a ciegas, comenzar vacío hasta que el usuario elija conscientemente
  useEffect(() => {
    setSelectedSpecialistModel((prev) => {
      if (prev && availableSpecialistModels.includes(prev)) return prev;
      return '';
    });
  }, [availableSpecialistModels]);

  // ¿El prefijo corresponde al sub-tipo Gemini objetivo (mismo paquete)?
  const prefixMatchesEffectiveFamily = useCallback((prefix) => {
    const p = (prefix || '').trim();
    if (!effectiveFamily) return false;
    if (effectiveFamily.key === 'gemini_pure') {
      return (
        (/^agy\d*(_\d+)?$/.test(p) || p.startsWith('g')) &&
        !p.startsWith('agy_clau') &&
        !p.startsWith('agy_son') &&
        !p.startsWith('agy_opus')
      );
    }
    if (effectiveFamily.key === 'gemini_sonnet') return p.startsWith('agy_son');
    if (effectiveFamily.key === 'gemini_opus') return p.startsWith('agy_opus');
    if (effectiveFamily.key === 'gemini_claude') return p.startsWith('agy_clau');
    return p.startsWith(effectiveFamily.hintPrefix);
  }, [effectiveFamily]);

  // Cuentas del rol objetivo sincronizadas directamente con Auto Auth Files
  const targetRoleCards = useMemo(() => {
    if (!targetFamilyRole) return [];
    return managedCards.filter((c) => c.familyRole === targetFamilyRole);
  }, [managedCards, targetFamilyRole]);

  // Cuentas libres en el rol objetivo
  const freeCardsInTargetRole = useMemo(() => {
    return targetRoleCards.filter((c) => !c.assignedPrefix || c.assignedPrefix.startsWith('unlinked_'));
  }, [targetRoleCards]);

  // ¿El nodo requiere clonación virtual? (master que sirve a la familia opuesta)
  const isVirtualSource = useCallback(
    (node) => {
      if (!node || !targetFamilyRole) return false;
      const classification = classifyAuthAccount(node);
      if (classification.isVirtual) return false; // ya es credencial derivada: se parchea
      const pref = (node.data?.prefix || '').trim();
      if (!pref || pref.startsWith('unlinked_')) return false; // master libre: parche in-place
      const isClaudePref =
        pref.startsWith('agy_son') || pref.startsWith('agy_opus') ||
        pref.startsWith('agy_clau') || pref.startsWith('clau') || pref.startsWith('son');
      const isGeminiPref = (pref.startsWith('agy') || pref.startsWith('g')) && !isClaudePref;
      if (targetFamilyRole === 'claude') return isGeminiPref; // master gemini → clonar para Claude
      if (targetFamilyRole === 'gemini') return isClaudePref; // master claude → clonar para Gemini
      return false;
    },
    [targetFamilyRole]
  );

  // Candidatos para líder: SOLO tarjetas LIBRES del rol objetivo (modelo 2N de Auto Auth Files)
  const leaderCandidates = useMemo(() => {
    if (!effectiveFamily) return [];
    const famProvider = effectiveFamily.provider;

    if (famProvider !== 'antigravity') {
      return nodes
        .filter((n) => {
          const prov = (n.data?.provider || n.data?.accountType || '').toLowerCase();
          const fileName = n.data?.fileName || n.name || n.id || '';
          const matchesProv = prov === famProvider || prov.includes(famProvider) || fileName.toLowerCase().startsWith(`${effectiveFamily.hintPrefix}-`);
          if (!matchesProv) return false;

          // Si ya está asignada a un pool registrado de esta misma familia/rol, no es libre
          const sameRoleMembers = registryMembersByRole.get(targetFamilyRole || famProvider);
          if (sameRoleMembers && sameRoleMembers.has(fileName)) return false;

          const pref = (n.data?.prefix || '').trim();
          return !pref || pref.startsWith('unlinked_');
        })
        .map((node) => ({ node, virtual: false }));
    }

    return freeCardsInTargetRole.map((card) => {
      // Buscar el nodo en el grafo que respalda a esta tarjeta
      let backingNode = null;
      if (card.virtualFileName) {
        backingNode = nodes.find(
          (n) => n.data?.fileName === card.virtualFileName || n.id === card.virtualFileName
        );
      }
      if (!backingNode && card.masterFileName) {
        backingNode = nodes.find(
          (n) => n.data?.fileName === card.masterFileName || n.id === card.masterFileName
        );
      }

      const node = backingNode || {
        id: card.virtualFileName || card.masterFileName,
        data: {
          fileName: card.virtualFileName || card.masterFileName,
          email: card.maskedEmail,
          prefix: card.assignedPrefix,
          provider: 'antigravity',
        },
      };

      const needsVirtualize = isVirtualSource(node);
      return { node, card, virtual: needsVirtualize };
    }).filter(({ node }) => {
      // [2N] Los miembros de un pool registrado de la MISMA familia-rol NO son candidatos
      // libres; estar en el pool Gemini NO impide armar el pool Claude con la misma cuenta
      const fileName = node.data?.fileName || node.name || node.id || '';
      const sameRoleMembers = registryMembersByRole.get(targetFamilyRole);
      return !(sameRoleMembers && sameRoleMembers.has(fileName));
    });
  }, [effectiveFamily, nodes, freeCardsInTargetRole, isVirtualSource, registryMembersByRole, targetFamilyRole]);

  // Cuentas de reserva compatibles: excluyen la cuenta líder seleccionada
  const reserveCandidates = useMemo(() => {
    if (!effectiveFamily || !selectedActiveNodeId) return [];
    const activeNode = nodes.find((n) => n.id === selectedActiveNodeId);
    const leaderEmail = activeNode?.data?.email || activeNode?.id;

    return leaderCandidates.filter(({ node }) => {
      const email = node.data?.email || node.id;
      return node.id !== selectedActiveNodeId && (!leaderEmail || email !== leaderEmail);
    });
  }, [effectiveFamily, selectedActiveNodeId, leaderCandidates, nodes]);

  const hasAntigravityAccounts = useMemo(
    () => nodes.some((n) => (n.data?.provider || n.data?.accountType || '').toLowerCase() === 'antigravity'),
    [nodes]
  );

  // Mapear pools existentes en el sistema agrupados por prefijo base.
  // FUENTE ÚNICA DE VERDAD: el registro del plugin (PoolRegistry). Los pools derivados
  // de prefijos en disco se incluyen solo si el registro no los cubre (pools legacy).
  const existingPools = useMemo(() => {
    const poolsMap = new Map();

    // 1) Pools registrados en el plugin (GroupManager = único generador)
    const sortedRegistered = sortPoolsByNumber(registeredPools);
    sortedRegistered.forEach((pool) => {
      const basePrefix = (pool.base_prefix || '').trim();
      if (!basePrefix || poolsMap.has(basePrefix)) return;

      const findNode = (authFileName) =>
        nodes.find((n) => (n.data?.fileName || n.name || n.id) === authFileName) || null;

      const root = pool.leader_auth ? findNode(pool.leader_auth) : null;
      const reserves = (Array.isArray(pool.reserves) ? pool.reserves : [])
        .map((auth, idx) => {
          const rNode = findNode(auth);
          return rNode
            ? { node: rNode, prefix: `${basePrefix}_${idx + 1}`, reserveIndex: idx + 1 }
            : null;
        })
        .filter(Boolean);

      // Si el pool no tiene ninguna cuenta física viva en nodes (fueron borradas en CPAMC),
      // descartar para evitar pools huérfanos/zombies y liberar el prefijo inmediatamente.
      if (!root && reserves.length === 0) {
        return;
      }

      const activeLeaderAuth = pool.active_leader || pool.leader_auth || '';
      const extractedNum = extractPoolNumber(pool);
      const poolIndex = extractedNum < 999999 ? extractedNum : (poolsMap.size + 1);
      const famStr = (pool.family || basePrefix || '').toLowerCase();
      const bpLower = (basePrefix || '').toLowerCase();
      let famSuffix = 'gemini';
      if (famStr.includes('codex') || bpLower.startsWith('codex')) {
        famSuffix = 'codex';
      } else if (famStr.includes('clau') || famStr.includes('son') || famStr.includes('opus') || bpLower.startsWith('clau')) {
        famSuffix = 'claude';
      } else if (famStr.includes('nim') || bpLower.startsWith('nim')) {
        famSuffix = 'nim';
      } else {
        // Buscar si coincide con proveedores de OmniAuth Pro (nim, nan, etc.)
        for (const [provKey, meta] of Object.entries(OMNIAUTH_PROVIDER_META)) {
          if (famStr.includes(provKey) || bpLower.startsWith(meta.hintPrefix)) {
            famSuffix = provKey;
            break;
          }
        }
      }
      const canonicalPoolName = `Pool-${String(poolIndex).padStart(2, '0')}-${famSuffix}`;
      const poolId = pool.id || canonicalPoolName;
      const displayName =
        pool.display_name && pool.display_name.startsWith('Pool-')
          ? pool.display_name
          : canonicalPoolName;
      const enabled = pool.enabled !== false;
      const memberModels = pool.member_models || {};

      let defaultRegisteredTargetModel = 'gemini-3.8-flash-high';
      if (famSuffix === 'claude') defaultRegisteredTargetModel = 'claude-sonnet-4-6';
      else if (famSuffix === 'codex') defaultRegisteredTargetModel = 'gpt-4o';
      else if (famSuffix === 'nim' || famSuffix === 'nvidia') defaultRegisteredTargetModel = OMNIAUTH_PROVIDER_META.nvidia?.models?.[0] || 'meta/llama-3.3-70b-instruct';
      else if (OMNIAUTH_PROVIDER_META[famSuffix]?.models?.[0]) defaultRegisteredTargetModel = OMNIAUTH_PROVIDER_META[famSuffix].models[0];

      const targetModel =
        (Array.isArray(pool.policy?.target_models) && pool.policy.target_models[0]) || defaultRegisteredTargetModel;

      poolsMap.set(basePrefix, {
        id: poolId,
        displayName,
        enabled,
        basePrefix,
        root,
        reserves,
        activeLeaderAuth,
        targetModel,
        memberModels,
        family: pool.family,
      });
    });

    // 2) Pools legacy detectados solo por prefijos en disco (no cubiertos por el registro)
    const registryCovered = new Set(
      registeredPools.map((p) => (p.base_prefix || '').trim()).filter(Boolean)
    );

    nodes.forEach((node) => {
      const pref = (node.data?.prefix || '').trim();
      if (!pref || pref.startsWith('unlinked_')) return;

      const reserveMatch = pref.match(/^(.*)_(\d+)$/);
      const baseKey = reserveMatch ? reserveMatch[1] : pref;
      // Los pools cubiertos por el registro son autoritativos: no mezclar miembros del disco
      if (registryCovered.has(baseKey)) return;

      const isReserve = !!reserveMatch;

      if (!poolsMap.has(baseKey)) {
        const poolIndex = poolsMap.size + 1;
        const bkLower = baseKey.toLowerCase();
        const nodeProv = getNodeProvider(node);
        let famSuffix = 'gemini';
        if (bkLower.includes('codex') || bkLower.startsWith('codex') || nodeProv === 'codex') {
          famSuffix = 'codex';
        } else if (bkLower.includes('clau') || bkLower.includes('son') || bkLower.includes('opus') || bkLower.startsWith('clau') || nodeProv === 'claude') {
          famSuffix = 'claude';
        } else if (bkLower === 'nim' || bkLower.startsWith('nim') || nodeProv === 'nvidia') {
          famSuffix = 'nim';
        } else {
          for (const [provKey, meta] of Object.entries(OMNIAUTH_PROVIDER_META)) {
            if (bkLower.startsWith(meta.hintPrefix) || nodeProv === provKey) {
              famSuffix = provKey;
              break;
            }
          }
        }
        const canonicalPoolName = `Pool-${String(poolIndex).padStart(2, '0')}-${famSuffix}`;
        let defaultLegacyTargetModel = 'gemini-3.8-flash-high';
        if (famSuffix === 'claude') {
          defaultLegacyTargetModel = 'claude-sonnet-4-6';
        } else if (famSuffix === 'codex') {
          defaultLegacyTargetModel = 'gpt-4o';
        } else if (famSuffix === 'nim' || famSuffix === 'nvidia') {
          defaultLegacyTargetModel = OMNIAUTH_PROVIDER_META.nvidia?.models?.[0] || 'meta/llama-3.3-70b-instruct';
        } else if (OMNIAUTH_PROVIDER_META[famSuffix]?.models?.[0]) {
          defaultLegacyTargetModel = OMNIAUTH_PROVIDER_META[famSuffix].models[0];
        }

        poolsMap.set(baseKey, {
          id: canonicalPoolName,
          displayName: canonicalPoolName,
          enabled: true,
          basePrefix: baseKey,
          root: null,
          reserves: [],
          targetModel: defaultLegacyTargetModel,
          memberModels: {},
        });
      }

      const pool = poolsMap.get(baseKey);
      if (!isReserve && !pool.root) {
        pool.root = node;
      } else {
        pool.reserves.push({
          node,
          prefix: pref,
          reserveIndex: reserveMatch ? parseInt(reserveMatch[2], 10) : 99,
        });
      }
    });

    // Filtrar pools: los pools de disco DEBEN tener rotación (al menos 1 reserva).
    // Cuentas sueltas con prefijo individual (0 reservas) son cuentas fijas / standalone, NO pools.
    const validPools = Array.from(poolsMap.values()).filter((p) => {
      if (registryCovered.has(p.basePrefix)) {
        return Boolean(p.root || (p.reserves && p.reserves.length > 0));
      }
      return Boolean(p.root && p.reserves && p.reserves.length >= 1);
    });

    // Ordenar pools por índice numérico soberano determinista y reservas por cascada
    const sortedPools = sortPoolsByNumber(validPools);
    return sortedPools.map((p) => {
      p.reserves.sort((a, b) => a.reserveIndex - b.reserveIndex);
      return p;
    });
  }, [nodes, registeredPools]);

  // Advertencia de convención de familia (agy* / agy_clau* / clau* / codex*) sobre el nombre del pool
  const familyMismatch = useMemo(() => {
    const trimmed = groupBasePrefix.trim();
    if (!effectiveFamily || !trimmed) return null;
    const hint = effectiveFamily.hintPrefix;

    // VALIDACIÓN 1: El prefijo base de un pool NUNCA debe terminar en _<número>
    // porque ese formato es exclusivo de cuentas de reserva (e.g. agy_1 es reserva de agy, no un pool).
    if (/_\d+$/.test(trimmed)) {
      const match = trimmed.match(/^(.*)_(\d+)$/);
      const suggested = match ? `${match[1]}${match[2]}` : trimmed.replace(/_/g, '');
      return {
        hint,
        message: `El formato "_<número>" está reservado para cuentas de reserva. Para un nuevo pool usa "${suggested}" en vez de "${trimmed}".`,
      };
    }

    // VALIDACIÓN 1B: Caracteres seguros (alineado con safePrefixPattern en el backend Go)
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      return {
        hint,
        message: 'El prefijo contiene caracteres inválidos. Solo se permiten caracteres alfanuméricos, guiones (-) y guiones bajos (_).',
      };
    }

    // VALIDACIÓN 2: Distinguir subtipos del paquete Gemini
    if (effectiveFamily.key === 'gemini_pure' && (trimmed.toLowerCase().startsWith('agy_clau') || trimmed.toLowerCase().startsWith('agy_son') || trimmed.toLowerCase().startsWith('agy_opus'))) {
      return {
        hint,
        message: 'Has seleccionado Gemini Puro, pero el prefijo inicia con un subtipo de Claude (agy_son/agy_opus/agy_clau). Usa "agy", "agy2", "agy3"...',
      };
    }

    if (effectiveFamily.key === 'gemini_sonnet' && !trimmed.toLowerCase().startsWith('agy_son')) {
      return {
        hint,
        message: 'Para Claude Sonnet del Paquete, el prefijo debe iniciar con "agy_son" (ej. agy_son, agy_son2...).',
      };
    }

    if (effectiveFamily.key === 'gemini_opus' && !trimmed.toLowerCase().startsWith('agy_opus')) {
      return {
        hint,
        message: 'Para Claude Opus del Paquete, el prefijo debe iniciar con "agy_opus" (ej. agy_opus, agy_opus2...).',
      };
    }

    if (effectiveFamily.key === 'gemini_claude' && !trimmed.toLowerCase().startsWith('agy_clau')) {
      return {
        hint,
        message: 'Para Claude Multipropósito, el prefijo debe iniciar con "agy_clau" (ej. agy_clau, agy_clau2...).',
      };
    }

    // VALIDACIÓN 3: Evitar colisión si el prefijo ya existe en otra cuenta activa
    const existingPoolPrefixes = new Set(
      nodes.map((n) => (n?.data?.prefix || '').trim()).filter(Boolean)
    );
    const currentActiveNodePrefix = (nodes.find((n) => n.id === selectedActiveNodeId)?.data?.prefix || '').trim();
    if (existingPoolPrefixes.has(trimmed) && trimmed !== currentActiveNodePrefix) {
      return {
        hint,
        message: `El prefijo "${trimmed}" ya está asignado a otra cuenta. Elige el siguiente libre (ej. ${suggestNextBasePrefix(nodes, hint)}).`,
      };
    }

    const isLegacyValid =
      (effectiveFamily.key === 'gemini_pure' && trimmed.toLowerCase().startsWith('g')) ||
      (effectiveFamily.key === 'claude' && trimmed.toLowerCase().startsWith('son'));

    if (trimmed.toLowerCase().startsWith(hint) || isLegacyValid) return null;

    return {
      hint,
      message: `La convención exige un prefijo que empiece con "${hint}" para vigilar la cuota de "${effectiveFamily.quota}". Con "${trimmed}" el switcher evaluará el peor caso de todas las familias.`,
    };
  }, [effectiveFamily, groupBasePrefix, nodes, selectedActiveNodeId]);

  const handleSelectFamily = useCallback((famKey) => {
    if (family !== famKey) {
      setSelectedActiveNodeId('');
      setSelectedReserveNodeIds([]);
    }
    setFamily(famKey);
    setErrorMessage('');
    setModelRoutes(null);
    setSaveReport(null);

    let hint = famKey && allModelFamilies[famKey] ? allModelFamilies[famKey].hintPrefix : null;
    if (famKey === 'gemini') {
      hint = MODEL_FAMILIES.gemini.subtypes[geminiSubtype].hintPrefix;
    }
    if (hint) {
      setGroupBasePrefix(suggestNextBasePrefix(nodes, hint));
    }
  }, [nodes, family, geminiSubtype, allModelFamilies]);

  const handleSelectGeminiSubtype = useCallback((subType) => {
    if (geminiSubtype !== subType) {
      setSelectedActiveNodeId('');
      setSelectedReserveNodeIds([]);
    }
    setGeminiSubtype(subType);
    setErrorMessage('');
    setModelRoutes(null);
    setSaveReport(null);

    const hint = MODEL_FAMILIES.gemini.subtypes[subType].hintPrefix;
    setGroupBasePrefix(suggestNextBasePrefix(nodes, hint));
  }, [nodes, geminiSubtype]);

  const handleCopyRoute = useCallback(async (route) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(route);
        setCopiedRoute(route);
        setTimeout(() => setCopiedRoute(''), 1500);
      }
    } catch {
      // clipboard no disponible: la ruta sigue visible para copia manual
    }
  }, []);

  // Seleccionar cuenta activa y autocompletar sugerencias
  const handleSelectActiveNode = useCallback((nodeId) => {
    setSelectedActiveNodeId(nodeId);
    setSelectedReserveNodeIds([]);
    setErrorMessage('');

    // Si el usuario ya ha escrito un prefijo manualmente en el input, no sobreescribirlo
    if (groupBasePrefix.trim()) {
      return;
    }

    const chosenNode = nodes.find((n) => n.id === nodeId);
    const chosenPref = (chosenNode?.data?.prefix || '').trim();

    if (chosenPref && !chosenPref.startsWith('unlinked_') && prefixMatchesEffectiveFamily(chosenPref)) {
      // Cargar el prefijo ya asignado en el auth-file solo si coincide con la familia activa
      setGroupBasePrefix(chosenPref);
    } else {
      // Sugerencia según familia elegida (o codex por defecto), sin colisión
      const hint = effectiveFamily ? effectiveFamily.hintPrefix : null;
      if (chosenNode) {
        const prov = (chosenNode.data?.provider || chosenNode.data?.accountType || '').toLowerCase();
        if (prov === 'codex') {
          setGroupBasePrefix('codex_');
          return;
        }
      }
      if (hint) {
        setGroupBasePrefix(suggestNextBasePrefix(nodes, hint));
      }
    }
  }, [nodes, groupBasePrefix, effectiveFamily, prefixMatchesEffectiveFamily]);

  const handleToggleReserve = useCallback((nodeId) => {
    setSelectedReserveNodeIds((prev) =>
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]
    );
  }, []);

  // Crear y guardar el nuevo pool vía PATCH en la API de gestión
  const handleCreateGroup = useCallback(async () => {
    const trimmedBase = groupBasePrefix.trim();
    if (!trimmedBase) {
      setErrorMessage('El prefijo base del pool no puede estar vacío.');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedBase)) {
      setErrorMessage('El prefijo solo puede contener letras, números, guiones y guiones bajos.');
      return;
    }
    if (!selectedActiveNodeId) {
      setErrorMessage('Debes seleccionar una cuenta Principal (Activa / Root).');
      return;
    }
    if (selectedReserveNodeIds.length === 0) {
      setErrorMessage('Mínimo 2 cuentas requeridas por grupo: debes seleccionar al menos 1 cuenta de reserva.');
      return;
    }

    const activeNode = nodes.find((n) => n.id === selectedActiveNodeId);
    if (!activeNode || !activeNode.data?.fileName) {
      setErrorMessage('No se encontró el archivo de autenticación de la cuenta principal.');
      return;
    }

    const updates = [];
    const virtualJobs = [];
    const registryOnlyFiles = [];
    const queueAssignment = (node, prefix) => {
      const fileName = node.data?.fileName || node.name;
      if (!fileName) return;
      // [2N] Una cuenta que ya pertenece a un pool registrado NO se toca en disco
      // (ni clon virtual ni parche de prefijo: preserva la otra familia). Su membresía
      // a esta nueva familia queda definida exclusivamente en el registro del plugin.
      if (registryMemberFileNames.has(fileName)) {
        registryOnlyFiles.push(fileName);
        return;
      }
      if (isVirtualSource(node)) {
        virtualJobs.push({ sourceFile: fileName, prefix, email: node.data?.email });
      } else {
        updates.push({ name: fileName, prefix });
      }
    };

    queueAssignment(activeNode, trimmedBase);
    const assignedPrefixes = new Set();
    const reserveFileNames = [];
    selectedReserveNodeIds.forEach((resId) => {
      const resNode = nodes.find((n) => n.id === resId);
      const resFileName = resNode?.data?.fileName || resNode?.name;
      if (!resFileName) return;
      reserveFileNames.push(resFileName);
      // Homologación: Las cuentas de reserva maestras reciben prefijo indexado (_1, _2...)
      // para que el planificador nativo de CPAMC no las confunda con cuentas libres sin prefijo.
      // La regla /_(\d+)$/ de la extensión de Pi las oculta automáticamente de /model.
      if (registryMemberFileNames.has(resFileName)) {
        registryOnlyFiles.push(resFileName);
      } else if (isVirtualSource(resNode)) {
        const reserveNum = nextReserveNumber(nodes, trimmedBase, assignedPrefixes);
        const reservePrefix = `${trimmedBase}_${reserveNum}`;
        assignedPrefixes.add(reservePrefix);
        virtualJobs.push({ sourceFile: resFileName, prefix: reservePrefix, email: resNode.data?.email });
      } else {
        const reserveNum = nextReserveNumber(nodes, trimmedBase, assignedPrefixes);
        const reservePrefix = `${trimmedBase}_${reserveNum}`;
        assignedPrefixes.add(reservePrefix);
        updates.push({ name: resFileName, prefix: reservePrefix });
      }
    });

    setIsSubmitting(true);
    setErrorMessage('');
    try {
      let targetModels = [];
      let oppositeModels = [];
      let allBaseModels = [];
      try {
        const { models } = await listModels();
        const knownPrefixes = new Set(
          nodes.map((n) => (n.data?.prefix || '').trim()).filter(Boolean)
        );
        const toBaseModelId = (id) => {
          let cur = (id || '').trim();
          while (cur.includes('/')) {
            cur = cur.slice(cur.indexOf('/') + 1);
          }
          return cur;
        };
        // Filtrar modelos válidos para la familia excluyendo identificadores de pools virtuales ('pool-...')
        const isNotVirtualPoolModel = (id) => {
          const lower = (id || '').toLowerCase();
          return !lower.startsWith('pool-') && !lower.includes('pool-');
        };

        const targetSet = new Set();
        const oppositeSet = new Set();
        const familyMatchingModels = [];

        // 1. Prioridad Máxima: Si la cuenta líder ya inspeccionó sus modelos nativos vía getAuthFileModels:
        const liveLeaderModels = selectedAuthModels.length > 0 ? selectedAuthModels.map(toBaseModelId).filter(Boolean) : [];

        models
          .map(toBaseModelId)
          .filter(Boolean)
          .filter(isNotVirtualPoolModel)
          .forEach((id) => {
            // Cirugía 2 / Idea 2: Si el modelo proviene de la credencial física viva seleccionada, es válido por definición
            const isLiveSupported = liveLeaderModels.includes(id);
            if (isLiveSupported || matchesFamilyModel(trimmedBase, id, excludeVersion55)) {
              familyMatchingModels.push(id);
            }
          });

        // REGLA ARQUITECTÓNICA SAGRADA (Especialista Único por Pool):
        // Cada pool creado es estrictamente especialista de 1 solo modelo.
        // El modelo elegido queda como único target y el resto de la familia como opuesto/bloqueado.
        const effectiveSpecialist = selectedSpecialistModel ||
          (trimmedBase.toLowerCase().startsWith('codex')
            ? (familyMatchingModels.find((m) => m.includes('gpt-6.1-sol') || m.includes('sol') || m.includes('gpt-4o')) || familyMatchingModels[0] || '')
            : (familyMatchingModels.find((m) => m.includes('3.8')) || familyMatchingModels[0] || ''));

        if (effectiveSpecialist) {
          targetSet.add(effectiveSpecialist);
          models
            .map(toBaseModelId)
            .filter(Boolean)
            .filter(isNotVirtualPoolModel)
            .forEach((id) => {
              if (id !== effectiveSpecialist) {
                oppositeSet.add(id);
              }
            });
        } else {
          // Fallback seguro si no hay modelos coincidentes detectados
          familyMatchingModels.forEach((id) => targetSet.add(id));
        }

        targetModels = [...targetSet];
        oppositeModels = [...oppositeSet];
        allBaseModels = [...new Set(models.map(toBaseModelId).filter(Boolean).filter(isNotVirtualPoolModel))];
      } catch {
        // Model listing is non-blocking
      }

      // [2N] Exclusiones union-aware: excluido = catálogo base − unión de los targets
      // de TODOS los pools a los que pertenece cada cuenta asignada. Para cuentas
      // solo en este pool equivale a la lista opuesta de la familia (legacy).
      const computeUnionExclusions = async (files, newPoolTargets) => {
        const exclusionsByFile = new Map();
        let existingPools = [];
        try {
          const res = await listPools();
          existingPools = Array.isArray(res?.pools) ? res.pools : [];
        } catch {
          // Registro no disponible: tratar todas como cuentas de un solo pool
        }
        const poolsByFile = new Map();
        existingPools.forEach((p) => {
          if (!p || !p.base_prefix) return;
          if (String(p.base_prefix).toLowerCase() === trimmedBase.toLowerCase()) return;
          const members = [p.leader_auth, ...(Array.isArray(p.reserves) ? p.reserves : [])].filter(Boolean);
          members.forEach((file) => {
            const list = poolsByFile.get(file) || [];
            list.push(p);
            poolsByFile.set(file, list);
          });
        });
        files.forEach((file) => {
          const union = new Set(newPoolTargets || []);
          (poolsByFile.get(file) || []).forEach((p) => {
            (p.policy?.target_models || []).forEach((m) => union.add(m));
          });
          exclusionsByFile.set(file, allBaseModels.filter((m) => !union.has(m)));
        });
        return exclusionsByFile;
      };

      // In-place patch of prefixes for non-virtual accounts
      const patchReport = updates.length > 0
        ? await saveAuthFilePrefixes(updates)
        : { successful: [], failed: [] };

      // Guardar definición de pool en el registro del plugin PRIMERO: el watcher de
      // archivos dispara re-registro (model.for_auth) que ya debe ver este pool.
      const leaderFileName = activeNode.data?.fileName || activeNode.name;
      const nextPoolIndex = existingPools.length + 1;
      const famKey = (effectiveFamily?.key || trimmedBase || '').toLowerCase();
      let famSuffix = 'gemini';
      if (famKey.includes('codex')) {
        famSuffix = 'codex';
      } else if (famKey.includes('clau') || famKey.includes('son') || famKey.includes('opus')) {
        famSuffix = 'claude';
      } else if (effectiveFamily?.isOmniAuthPro || effectiveFamily?.provider) {
        famSuffix = effectiveFamily.provider;
      }
      const canonicalPoolName = `Pool-${String(nextPoolIndex).padStart(2, '0')}-${famSuffix}`;
      let defaultFamilyModel = 'gemini-3.8-flash-high';
      if (famSuffix === 'codex') {
        defaultFamilyModel = 'gpt-6.1-sol';
      } else if (famSuffix === 'claude') {
        defaultFamilyModel = 'claude-sonnet-4-6';
      }
      const chosenModel = targetModels[0] || selectedSpecialistModel || defaultFamilyModel;
      const memberModelsMap = { [leaderFileName]: chosenModel };
      reserveFileNames.forEach((rf) => {
        memberModelsMap[rf] = chosenModel;
      });
      const resolvedFamilyKey = effectiveFamily?.key || (famSuffix === 'codex' ? 'codex' : famSuffix === 'claude' ? 'claude' : 'gemini_pure');
      const poolPayload = {
        id: canonicalPoolName,
        name: canonicalPoolName,
        display_name: canonicalPoolName,
        route_slug: canonicalPoolName,
        enabled: true,
        family: resolvedFamilyKey,
        base_prefix: trimmedBase,
        members: [leaderFileName, ...reserveFileNames],
        member_models: memberModelsMap,
        active_leader: leaderFileName,
        leader_auth: leaderFileName,
        leader_email: activeNode.data?.email || '',
        reserves: reserveFileNames,
        policy: {
          disable_isolation: false,
          exclude_55: Boolean(excludeVersion55),
          target_models: targetModels.length > 0 ? targetModels : [chosenModel],
          excluded_models: oppositeModels,
        },
      };

      try {
        await savePool(poolPayload);
      } catch (poolErr) {
        console.warn('savePool error in registry:', poolErr);
      }

      // NOTA ARQUITECTÓNICA (Gobernanza Virtual Pura):
      // Las cuentas físicas en disco NO deben mutar su `excluded_models`.
      // Si se inyecta `excluded_models` en el archivo .json, CPAMC nativo oculta y mutila
      // el catálogo de modelos de la credencial en su vista nativa de Auth Files.
      // El aislamiento de modelo especialista (1 Pool = 1 Modelo) lo gestiona 100% el plugin
      // a través de `poolPayload.policy` y el enrutador virtual `model.route` / `scheduler.pick`.
      // Por ende, NUNCA sobreescribimos las exclusiones físicas del disco al crear pools.

      const successful = [
        ...patchReport.successful,
        ...virtualJobs.map((j) => ({ name: j.sourceFile, prefix: j.prefix })),
      ];
      const failed = patchReport.failed.map((f) => ({ ...f, kind: 'patch' }));

      const total = updates.length + virtualJobs.length + registryOnlyFiles.length;
      if (failed.length > 0) {
        setSaveReport({ base: trimmedBase, successful, failed });
        setErrorMessage(
          `Pool "${trimmedBase}" guardado con errores parciales: fallaron ${failed.length} de ${total} cuentas.`
        );
      } else {
        setSaveReport(null);
        const virtualNote = virtualJobs.length > 0 ? ` (${virtualJobs.length} virtualizada[s])` : '';
        const registryNote = registryOnlyFiles.length > 0 ? ` · ${registryOnlyFiles.length} vía registro (2N)` : '';
        setSuccessFeedback(`⚡ Pool "${trimmedBase}" creado y guardado con éxito (${updates.length + virtualJobs.length + registryOnlyFiles.length} cuentas${virtualNote})${registryNote}.`);
        setGroupBasePrefix('');
        setSelectedActiveNodeId('');
        setSelectedReserveNodeIds([]);
        try {
          const { models } = await listModels();
          setModelRoutes({
            base: trimmedBase,
            routes: models.filter((id) => id.startsWith(`${trimmedBase}/`) && matchesFamilyModel(trimmedBase, id, excludeVersion55)),
          });
        } catch {
          setModelRoutes(null);
        }
        if (typeof onReloadRequested === 'function') {
          await onReloadRequested();
        }
      }
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(() => setSuccessFeedback(''), 4000);
    } catch (err) {
      setErrorMessage(`Error al guardar pool: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }, [groupBasePrefix, selectedActiveNodeId, selectedReserveNodeIds, nodes, onReloadRequested, effectiveFamily, excludeVersion55, selectedSpecialistModel, isVirtualSource, registryMemberFileNames, registryMembersByRole]);

  // Valida y lanza el modal comunitario si corresponde o ejecuta directamente el guardado
  const handleInitiateCreateGroup = useCallback(() => {
    const trimmedBase = groupBasePrefix.trim();
    if (!trimmedBase) {
      setErrorMessage('El prefijo base del pool no puede estar vacío.');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedBase)) {
      setErrorMessage('El prefijo solo puede contener letras, números, guiones y guiones bajos.');
      return;
    }
    if (!selectedActiveNodeId) {
      setErrorMessage('Debes seleccionar una cuenta Principal (Activa / Root).');
      return;
    }
    if (selectedReserveNodeIds.length === 0) {
      setErrorMessage('Mínimo 2 cuentas requeridas por grupo: debes seleccionar al menos 1 cuenta de reserva.');
      return;
    }

    try {
      const isSupporter = typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY_SUPPORTER) === 'true';
      const dismissedUntil = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY_DISMISSED) : null;
      const isDismissedToday = dismissedUntil && Number(dismissedUntil) > Date.now();

      if (!isSupporter && !isDismissedToday) {
        pendingCreationRef.current = true;
        setIsNoticeOpen(true);
        return;
      }
    } catch {}

    // Si es supporter o pospuso hoy, guarda directamente
    handleCreateGroup();
  }, [groupBasePrefix, selectedActiveNodeId, selectedReserveNodeIds, handleCreateGroup]);

  const handleNoticeCloseAndContinue = useCallback(() => {
    setIsNoticeOpen(false);
    if (pendingCreationRef.current) {
      pendingCreationRef.current = false;
      handleCreateGroup();
    }
  }, [handleCreateGroup]);

  // Reintentar solo las cuentas que fallaron en el último guardado
  const handleRetryFailed = useCallback(async () => {
    if (!saveReport || saveReport.failed.length === 0) return;
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const results = await Promise.allSettled(
        saveReport.failed.map((entry) => {
          if (entry.kind === 'virtual') {
            return virtualizeAccount({
              sourceFileName: entry.sourceFile,
              prefix: entry.prefix,
              targetModels: entry.targetModels,
              targetPatterns: entry.targetPatterns,
              oppositeModels: entry.oppositeModels,
            });
          }
          return saveAuthFilePrefixes([{ name: entry.name, prefix: entry.prefix }]);
        })
      );

      const successful = [...saveReport.successful];
      const failed = [];
      results.forEach((res, idx) => {
        const entry = saveReport.failed[idx];
        if (res.status === 'fulfilled') {
          if (entry.kind === 'virtual') {
            successful.push({ name: res.value?.name || entry.name, prefix: entry.prefix });
          } else if (res.value.failed.length > 0) {
            failed.push(entry);
          } else {
            successful.push({ name: entry.name, prefix: entry.prefix });
          }
        } else {
          failed.push({ ...entry, error: res.reason?.message || entry.error });
        }
      });

      if (failed.length > 0) {
        setSaveReport((prev) => ({ base: prev.base, successful, failed }));
        setErrorMessage(`Reintento fallido para ${failed.length} cuenta(s).`);
      } else {
        setSaveReport(null);
        setSuccessFeedback(`⚡ Pool "${saveReport.base}" creado y guardado con éxito (reintento completado).`);
        if (typeof onReloadRequested === 'function') {
          await onReloadRequested();
        }
        try {
          const { models } = await listModels();
          setModelRoutes({
            base: saveReport.base,
            routes: models.filter((id) => id.startsWith(`${saveReport.base}/`) && matchesFamilyModel(saveReport.base, id)),
          });
        } catch {
          setModelRoutes(null);
        }
        if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
        feedbackTimeoutRef.current = setTimeout(() => setSuccessFeedback(''), 4000);
      }
    } catch (err) {
      setErrorMessage(`Error al reintentar: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }, [saveReport, nodes, onReloadRequested]);

  // Disolver un pool completo liberando sus cuentas.
  // CRÍTICO: incluye también descendientes profundos (agy_1_1, agy_2_3_1, ...)
  // pero NUNCA disuelve pools hermanos con nombres parecidos (ej. 'agy' no disuelve 'agy_clau'
  // porque el sufijo de este último es alfabético y no numérico).
  const handleDissolvePool = useCallback(async (pool) => {
    const descendants = nodes.filter((n) => {
      const pref = (n.data?.prefix || '').trim();
      return isPoolDescendant(pool.basePrefix, pref);
    });
    const memberIds = new Set([
      ...(pool.root ? [pool.root.id] : []),
      ...pool.reserves.map(({ node }) => node.id),
    ]);
    const deepNodes = descendants.filter((n) => !memberIds.has(n.id));

    const confirmMsg = deepNodes.length > 0
      ? `¿Seguro que deseas disolver el pool "${pool.basePrefix}"? Se liberarán ${(pool.root ? 1 : 0) + pool.reserves.length} cuentas directas y ${deepNodes.length} descendiente(s) profundo(s) (ej. "${pool.basePrefix}_1_1").`
      : `¿Seguro que deseas disolver el pool "${pool.basePrefix}"? Todas sus cuentas volverán a estar libres.`;
    if (!window.confirm(confirmMsg)) return;

    const masterUpdates = [];
    const virtualDeletions = [];
    const memberMasterFiles = new Set();

    descendants.forEach((node) => {
      const fileName = node.data?.fileName || node.name || '';
      if (!fileName) return;
      const classification = classifyAuthAccount(node);
      if (classification.isVirtual) {
        virtualDeletions.push(fileName);
      } else {
        masterUpdates.push({ name: fileName, prefix: '' });
        memberMasterFiles.add(fileName);
      }
    });

    // [2N] Miembros del pool definidos solo en el registro (sin prefijo propio en disco):
    // también deben recuperar su catálogo al disolver.
    (pool.reserves || []).forEach(({ node }) => {
      const fileName = node?.data?.fileName || node?.name || '';
      if (fileName) memberMasterFiles.add(fileName);
    });
    if (pool.root?.data?.fileName) {
      memberMasterFiles.add(pool.root.data.fileName);
    }

    setIsSubmitting(true);
    try {
      try {
        await dissolvePool(pool.basePrefix);
      } catch (dissolveErr) {
        console.warn('dissolvePool registry error:', dissolveErr);
      }

      const deleteResults = virtualDeletions.length > 0
        ? await Promise.allSettled(virtualDeletions.map((fn) => deleteAuthFile(fn)))
        : [];
      const patchReport = masterUpdates.length > 0
        ? await saveAuthFilePrefixes(masterUpdates)
        : { successful: [], failed: [] };

      // [2N] Re-parche union-aware de exclusiones para los miembros liberados:
      // excluido = catálogo base − unión de los targets de los pools REMANENTES de la
      // cuenta (vacío cuando ya no pertenece a ningún pool: catálogo base completo).
      try {
        // Gobernanza Virtual Pura (Cero Mutación en Disco):
        // Al disolver un pool NO inyectamos exclusiones físicas en disco (/root/.cli-proxy-api/*.json).
        // Las credenciales físicas en disco deben mantener excluded_models: [] de fábrica para que
        // CPAMC native "Auth Files Management" conserve el catálogo completo y el failover opere sin trabas.
        await Promise.allSettled(
          [...memberMasterFiles].map((file) => patchAuthFileExclusions(file, []))
        );
      } catch (exclusionErr) {
        console.warn('dissolve exclusion reset error:', exclusionErr);
      }

      const failedDeletions = deleteResults.filter((r) => r.status === 'rejected');
      const totalFailed = failedDeletions.length + patchReport.failed.length;
      if (totalFailed > 0) {
        setErrorMessage(
          `Error al disolver pool: fallaron ${totalFailed} de ${masterUpdates.length + virtualDeletions.length} operaciones.`
        );
      } else {
        const parts = [];
        if (virtualDeletions.length > 0) {
          parts.push(`${virtualDeletions.length} cuenta(s) virtual(es) eliminada(s) de disco`);
        }
        if (masterUpdates.length > 0) {
          parts.push(`${masterUpdates.length} cuenta(s) maestra(s) liberada(s)`);
        }
        setSuccessFeedback(`💥 Pool "${pool.basePrefix}" disuelto exitosamente (${parts.join(', ')}).`);
      }
      if (typeof onReloadRequested === 'function') {
        await onReloadRequested();
      }
    } catch (err) {
      setErrorMessage(`Error al disolver pool: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }, [nodes, onReloadRequested]);

  // Adoptar una cuenta libre dentro de un pool existente como nueva reserva
  const handleAdoptAccountIntoPool = useCallback(async (targetPoolBase, targetNode, customSpecialistModel = '') => {
    if (!targetPoolBase || !targetNode) return;
    const fileName = targetNode.data?.fileName || targetNode.name || targetNode.id || '';
    const email = targetNode.data?.email || fileName;
    if (!fileName) return;

    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const poolDef = registeredPools.find((p) => p.base_prefix === targetPoolBase);
      const existingPool = existingPools.find((p) => p.basePrefix === targetPoolBase);

      const currentReserves = poolDef?.reserves
        ? [...poolDef.reserves]
        : (existingPool?.reserves || [])
            .map((r) => r.node?.data?.fileName || r.node?.name || r.node?.id)
            .filter(Boolean);

      const nextNum = Math.max(
        nextReserveNumber(nodes, targetPoolBase),
        currentReserves.length + 1
      );
      const newPrefix = `${targetPoolBase}_${nextNum}`;

      try {
        await saveAuthFilePrefixes([{ name: fileName, prefix: newPrefix }]);
      } catch (patchErr) {
        console.warn('saveAuthFilePrefixes warning on adopt:', patchErr);
      }

      if (!currentReserves.includes(fileName)) {
        currentReserves.push(fileName);
      }

      const rootNode = existingPool?.root;
      const leaderFile =
        poolDef?.leader_auth ||
        rootNode?.data?.fileName ||
        rootNode?.name ||
        rootNode?.id ||
        '';
      const leaderEmail = poolDef?.leader_email || rootNode?.data?.email || '';

      const effectiveModel =
        customSpecialistModel ||
        (Array.isArray(poolDef?.policy?.target_models) && poolDef.policy.target_models[0]) ||
        selectedSpecialistModel ||
        (targetPoolBase.startsWith('clau') || targetPoolBase.startsWith('agy_son') || targetPoolBase.startsWith('agy_clau')
          ? 'claude-sonnet-4-6'
          : targetPoolBase.startsWith('agy_opus')
          ? 'claude-opus-4-6-thinking'
          : 'gemini-3.8-flash-high');

      const updatedMemberModels = {
        ...(poolDef?.member_models || existingPool?.memberModels || {}),
        [fileName]: effectiveModel,
      };

      const poolPayload = {
        id: poolDef?.id || existingPool?.id || `Pool-01-gemini`,
        name: poolDef?.name || existingPool?.displayName || targetPoolBase,
        display_name: poolDef?.display_name || existingPool?.displayName || `Pool-01-gemini`,
        route_slug: poolDef?.route_slug || existingPool?.displayName || targetPoolBase,
        enabled: poolDef?.enabled !== false,
        family: poolDef?.family || effectiveFamily?.key || 'gemini_pure',
        base_prefix: targetPoolBase,
        members: [leaderFile, ...currentReserves].filter(Boolean),
        member_models: updatedMemberModels,
        active_leader: poolDef?.active_leader || leaderFile,
        leader_auth: leaderFile,
        leader_email: leaderEmail,
        reserves: currentReserves,
        policy: {
          ...(poolDef?.policy || {}),
          disable_isolation: false,
          exclude_55: Boolean(poolDef?.policy?.exclude_55 ?? excludeVersion55),
          target_models:
            Array.isArray(poolDef?.policy?.target_models) && poolDef.policy.target_models.length > 0
              ? poolDef.policy.target_models
              : [effectiveModel],
          excluded_models: poolDef?.policy?.excluded_models || [],
        },
      };

      try {
        await savePool(poolPayload);
      } catch (poolErr) {
        console.warn('savePool error on adopt:', poolErr);
      }

      setRegisteredPools((prev) => {
        const exists = prev.some((p) => p.base_prefix === targetPoolBase);
        const next = exists
          ? prev.map((p) => (p.base_prefix === targetPoolBase ? poolPayload : p))
          : [...prev, poolPayload];
        return sortPoolsByNumber(next);
      });

      setSuccessFeedback(
        `✅ Cuenta "${email}" adoptada con éxito como Reserva en el pool "${targetPoolBase}" (prefijo [${newPrefix}] · Modelo: ${effectiveModel}).`
      );
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(() => setSuccessFeedback(''), 5000);

      if (typeof onReloadRequested === 'function') {
        await onReloadRequested();
      }
    } catch (err) {
      setErrorMessage(`Error al adoptar cuenta en el pool: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }, [registeredPools, existingPools, nodes, effectiveFamily, excludeVersion55, selectedSpecialistModel, onReloadRequested]);

  // Liberar individualmente una reserva de un pool sin disolver el pool completo
  const handleReleaseReserve = useCallback(async (targetPoolBase, reserveNode) => {
    if (!targetPoolBase || !reserveNode) return;
    const fileName = reserveNode.data?.fileName || reserveNode.name || reserveNode.id || '';
    const email = reserveNode.data?.email || fileName;
    if (!fileName) return;

    const existingPool = existingPools.find((p) => p.basePrefix === targetPoolBase);
    if (existingPool && existingPool.reserves.length <= 1) {
      if (
        !window.confirm(
          `⚠️ Esta es la única reserva del pool "${targetPoolBase}". Si la liberas, el pool quedará sin suplentes de respaldo. ¿Deseas continuar?`
        )
      ) {
        return;
      }
    } else {
      if (
        !window.confirm(
          `¿Liberar la cuenta de reserva "${email}" del pool "${targetPoolBase}"? La cuenta volverá a estar libre.`
        )
      ) {
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMessage('');
    try {
      try {
        await saveAuthFilePrefixes([{ name: fileName, prefix: '' }]);
      } catch (patchErr) {
        console.warn('saveAuthFilePrefixes warning on release reserve:', patchErr);
      }

      const poolDef = registeredPools.find((p) => p.base_prefix === targetPoolBase);
      if (poolDef) {
        const updatedReserves = (poolDef.reserves || []).filter((f) => f !== fileName);
        const updatedMembers = (poolDef.members || []).filter((f) => f !== fileName);
        const updatedMemberModels = { ...(poolDef.member_models || {}) };
        delete updatedMemberModels[fileName];

        let updatedActiveLeader = poolDef.active_leader;
        if (updatedActiveLeader === fileName) {
          updatedActiveLeader = poolDef.leader_auth || (updatedReserves.length > 0 ? updatedReserves[0] : '');
        }

        const updatedPayload = {
          ...poolDef,
          members: updatedMembers,
          reserves: updatedReserves,
          member_models: updatedMemberModels,
          active_leader: updatedActiveLeader,
        };
        try {
          await savePool(updatedPayload);
        } catch (poolErr) {
          console.warn('savePool error on release reserve:', poolErr);
        }
        setRegisteredPools((prev) =>
          sortPoolsByNumber(prev.map((p) => (p.base_prefix === targetPoolBase ? updatedPayload : p)))
        );
      }

      setSuccessFeedback(`✓ Reserva "${email}" liberada del pool "${targetPoolBase}". Ahora está libre.`);
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(() => setSuccessFeedback(''), 5000);

      if (typeof onReloadRequested === 'function') {
        await onReloadRequested();
      }
    } catch (err) {
      setErrorMessage(`Error al liberar reserva: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }, [registeredPools, existingPools, onReloadRequested]);

  // Liberar el líder actual de un pool: promueve la primera reserva a líder y re-indexa los prefijos
  const handleReleaseLeader = useCallback(async (targetPoolBase, leaderNode) => {
    if (!targetPoolBase || !leaderNode) return;
    const fileName = leaderNode.data?.fileName || leaderNode.name || leaderNode.id || '';
    const email = leaderNode.data?.email || fileName;
    if (!fileName) return;

    const existingPool = existingPools.find((p) => p.basePrefix === targetPoolBase);
    const reserves = existingPool?.reserves || [];

    if (reserves.length === 0) {
      if (
        !window.confirm(
          `⚠️ Esta cuenta es el único miembro del pool "${targetPoolBase}". Para liberarla se disolverá el pool completo. ¿Deseas disolver el pool?`
        )
      ) {
        return;
      }
      return handleDissolvePool(existingPool);
    }

    if (
      !window.confirm(
        `¿Liberar la cuenta líder "${email}" del pool "${targetPoolBase}"? Se promoverá la primera reserva a nuevo líder del pool.`
      )
    ) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const nextLeaderNode = reserves[0].node;
      const nextLeaderFile = nextLeaderNode?.data?.fileName || nextLeaderNode?.name || nextLeaderNode?.id || '';
      const remainingReserves = reserves.slice(1);

      // Parchear prefijos en disco
      const prefixUpdates = [
        { name: fileName, prefix: '' },
        { name: nextLeaderFile, prefix: targetPoolBase },
        ...remainingReserves.map((r, idx) => ({
          name: r.node?.data?.fileName || r.node?.name || r.node?.id || '',
          prefix: `${targetPoolBase}_${idx + 1}`,
        })),
      ].filter((u) => Boolean(u.name));

      try {
        await saveAuthFilePrefixes(prefixUpdates);
      } catch (patchErr) {
        console.warn('saveAuthFilePrefixes warning on release leader:', patchErr);
      }

      const poolDef = registeredPools.find((p) => p.base_prefix === targetPoolBase);
      const remainingReserveFiles = remainingReserves.map((r) => r.node?.data?.fileName || r.node?.name || r.node?.id).filter(Boolean);
      const newMembers = [nextLeaderFile, ...remainingReserveFiles];

      const updatedMemberModels = { ...(poolDef?.member_models || existingPool?.memberModels || {}) };
      delete updatedMemberModels[fileName];

      const updatedPayload = {
        ...(poolDef || {}),
        base_prefix: targetPoolBase,
        leader_auth: nextLeaderFile,
        leader_email: nextLeaderNode?.data?.email || nextLeaderFile,
        active_leader: nextLeaderFile,
        members: newMembers,
        reserves: remainingReserveFiles,
        member_models: updatedMemberModels,
      };

      try {
        await savePool(updatedPayload);
      } catch (poolErr) {
        console.warn('savePool error on release leader:', poolErr);
      }

      setRegisteredPools((prev) => {
        const exists = prev.some((p) => p.base_prefix === targetPoolBase);
        const next = exists
          ? prev.map((p) => (p.base_prefix === targetPoolBase ? updatedPayload : p))
          : [...prev, updatedPayload];
        return sortPoolsByNumber(next);
      });

      setSuccessFeedback(`✓ Cuenta líder "${email}" liberada del pool "${targetPoolBase}". "${nextLeaderNode?.data?.email || nextLeaderFile}" promovida a líder.`);
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(() => setSuccessFeedback(''), 5000);

      if (typeof onReloadRequested === 'function') {
        await onReloadRequested();
      }
    } catch (err) {
      setErrorMessage(`Error al liberar líder: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }, [registeredPools, existingPools, handleDissolvePool, onReloadRequested]);

  const providerAuraClass = family ? `provider-${family}` : 'provider-neutral';

  return (
    <div className={`group-manager-container ${providerAuraClass}`} data-testid="group-manager-view">
      {/* Header Principal Bento 2027 */}
      <div className="group-manager-header">
        <div className="group-manager-title-area">
          <div className="group-manager-title-row">
            <span className="group-manager-icon">⚡</span>
            <h2 className="group-manager-title">Constructor de Pools</h2>
            <span className="group-manager-badge-2027">v2027 · Failover Engine</span>
          </div>
          <p className="group-manager-desc">
            Orquesta pools virtuales de balanceo de carga y alta disponibilidad para CPAMC con failover automático y cero downtime.
          </p>
        </div>
      </div>

      {/* Feedback Toasts */}
      {successFeedback && (
        <div style={{
          background: 'rgba(16, 185, 129, 0.2)',
          border: '1px solid #10b981',
          color: '#6ee7b7',
          padding: '10px 16px',
          borderRadius: 8,
          marginBottom: 16,
          fontSize: 13,
          fontWeight: 600,
        }}>
          {successFeedback}
        </div>
      )}

      {errorMessage && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.2)',
          border: '1px solid #ef4444',
          color: '#fca5a5',
          padding: '10px 16px',
          borderRadius: 8,
          marginBottom: 16,
          fontSize: 13,
          fontWeight: 600,
        }}>
          ⚠️ {errorMessage}
        </div>
      )}

      {/* Navegación por Pestañas Bento */}
      <div className="group-manager-tabs">
        <button
          type="button"
          className={`group-manager-tab ${activeTab === 'create' ? 'active' : ''}`}
          onClick={() => setActiveTab('create')}
          data-testid="tab-armar-pool"
        >
          <span>⚡</span>
          <span>Armar Nuevo Pool</span>
        </button>
        <button
          type="button"
          className={`group-manager-tab ${activeTab === 'dissolve' ? 'active' : ''}`}
          onClick={() => setActiveTab('dissolve')}
          data-testid="tab-disolver-pools"
        >
          <span>💥</span>
          <span>Disolver / ➕ Sumar / Adoptar Reservas ({existingPools.length})</span>
        </button>
      </div>

      {/* Pestaña: Armar Nuevo Pool */}
      {activeTab === 'create' && (
        <div className="group-manager-content">
          <div className="group-builder-col">
            {freeNodes.length === 0 && !hasAntigravityAccounts ? (
              <div className="group-empty-alert" data-testid="empty-free-nodes-alert">
                <span className="group-alert-icon">⚠️</span>
                <h4 className="group-alert-title">No hay cuentas libres disponibles</h4>
                <p className="group-alert-desc">
                  Todas las cuentas están asignadas a grupos existentes. Para armar un nuevo pool, ve a la pestaña <strong>"💥 Disolver / Desagrupar Pools"</strong> para liberar cuentas.
                </p>
                <button
                  type="button"
                  className="group-prefix-chip"
                  onClick={() => setActiveTab('dissolve')}
                  style={{ marginTop: 12, padding: '8px 16px', fontSize: 12 }}
                  data-testid="btn-go-to-dissolve"
                >
                  💥 Ir a Disolver / Liberar Cuentas
                </button>
              </div>
            ) : (
              <div className="group-card">
                <h3 className="group-card-title" data-testid="group-card-title">
                  <span>⚡</span>
                  <span>Estructuración de Grupo & Pool</span>
                  <span className="group-card-title-sep">:</span>
                  <span className="group-card-title-subtitle">
                    <span className="group-card-title-item">Google Gemini</span>
                    <span className="group-card-title-slash">/</span>
                    <span className="group-card-title-item">Anthropic Claude</span>
                    <span className="group-card-title-slash">/</span>
                    <span className="group-card-title-item">OpenAI Codex</span>
                    <span className="group-card-title-slash">/</span>
                    <span className="group-card-title-item">Otros</span>
                  </span>
                </h3>

                {/* Paso 1: Familia de modelos */}
                <div className="group-field">
                  <label className="group-label">① Familia de modelos (define qué cuota se vigila):</label>
                  <div className="group-family-segmented" role="group">
                    {Object.entries(allModelFamilies).map(([key, fam]) => {
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`group-family-chip ${family === key ? 'active' : ''}`}
                          onClick={() => handleSelectFamily(key)}
                          data-testid={`family-${key}`}
                        >
                          <span className="group-family-icon">{fam.icon}</span>
                          <span className="group-family-label">{fam.label}</span>
                          <span className="group-family-hint">
                            {key === 'gemini'
                              ? 'Modelos Gemini & Claude'
                              : key === 'codex'
                                ? 'Modelos GPT & Codex'
                                : (fam.quota || fam.label)}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Sub-selector en la misma columna para el Paquete Gemini */}
                  {family === 'gemini' && (
                    <div className="group-subfamily-container" data-testid="gemini-subfamily-container">
                      <div className="group-subfamily-title">
                        <span>📦</span>
                        <span>Especialidad / Cuota dentro del Paquete Gemini:</span>
                      </div>
                      <div className="group-subfamily-segmented" role="group">
                        <button
                          type="button"
                          className={`group-subfamily-chip ${geminiSubtype === 'pure' ? 'active' : ''}`}
                          onClick={() => handleSelectGeminiSubtype('pure')}
                          data-testid="subfamily-gemini-pure"
                        >
                          <span className="group-subfamily-label">🔷 Gemini Puro</span>
                          <span className="group-subfamily-hint">Cuota: Gemini Models</span>
                        </button>
                        {hasClaudeInAntigravity && (
                          <>
                            <button
                              type="button"
                              className={`group-subfamily-chip ${geminiSubtype === 'sonnet' ? 'active' : ''}`}
                              onClick={() => handleSelectGeminiSubtype('sonnet')}
                              data-testid="subfamily-gemini-sonnet"
                            >
                              <span className="group-subfamily-label">🔶 Claude Sonnet</span>
                              <span className="group-subfamily-hint">claude-sonnet 4.6 & 5.5</span>
                            </button>
                            <button
                              type="button"
                              className={`group-subfamily-chip ${geminiSubtype === 'opus' ? 'active' : ''}`}
                              onClick={() => handleSelectGeminiSubtype('opus')}
                              data-testid="subfamily-gemini-opus"
                            >
                              <span className="group-subfamily-label">🟣 Claude Opus</span>
                              <span className="group-subfamily-hint">claude-opus 4.6 & 5.5 High</span>
                            </button>
                            <button
                              type="button"
                              className={`group-subfamily-chip ${geminiSubtype === 'claude' ? 'active' : ''}`}
                              onClick={() => handleSelectGeminiSubtype('claude')}
                              data-testid="subfamily-gemini-claude"
                            >
                              <span className="group-subfamily-label">🎭 Antigravity Dual</span>
                              <span className="group-subfamily-hint">Cuota: Claude & GPT</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                </div>

                {/* Badge de Capacidad e Información en Tiempo Real (Unificado en una sola línea) */}
                {family && (() => {
                  const totalEligible = leaderCandidates.length;
                  const maxGroups = Math.floor(totalEligible / 2);
                  const noteText = effectiveFamily?.note ? (
                    excludeVersion55 && (effectiveFamily.key.includes('claude') || effectiveFamily.key.includes('sonnet') || effectiveFamily.key.includes('opus'))
                      ? effectiveFamily.note.replace(/(claude-[a-z]+-5-5[a-z-]*)/gi, '$1 (versión 5.5 excluida)')
                      : effectiveFamily.note
                  ) : '';

                  const badgeBorder = totalEligible === 0
                    ? 'rgba(148, 163, 184, 0.4)'
                    : totalEligible === 1
                      ? 'rgba(234, 179, 8, 0.4)'
                      : 'rgba(16, 185, 129, 0.4)';
                  const badgeBg = totalEligible === 0
                    ? 'rgba(15, 23, 42, 0.6)'
                    : totalEligible === 1
                      ? 'rgba(234, 179, 8, 0.08)'
                      : 'rgba(16, 185, 129, 0.08)';

                  return (
                    <div
                      className="group-capacity-badge"
                      data-testid="capacity-badge"
                      style={{
                        borderColor: badgeBorder,
                        background: badgeBg,
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 8,
                      }}
                    >
                      {noteText && (
                        <>
                          <span className="group-family-note" data-testid="group-family-note" style={{ margin: 0, color: '#94a3b8' }}>
                            ℹ️ {noteText}
                          </span>
                          <span style={{ color: '#475569' }}>·</span>
                        </>
                      )}
                      {totalEligible === 0 && (
                        <span data-testid="no-compatible-accounts-alert">
                          <strong>0 cuentas libres</strong> (operando en pools activos). Libera cuentas en <em>"💥 Disolver / Adoptar"</em> o vincula una nueva en CPAMC.
                        </span>
                      )}
                      {totalEligible === 1 && (
                        <span>⚠️ <strong>Tienes 1 cuenta libre</strong> · Necesitas al menos 1 Titular + 1 Suplente para activar rotación.</span>
                      )}
                      {totalEligible >= 2 && (
                        <span>✅ <strong>{totalEligible} cuentas listas</strong> · Puedes armar hasta <strong>{maxGroups}</strong> {maxGroups === 1 ? 'pool' : 'pools'} de rotación (o 1 pool con {totalEligible - 1} {totalEligible - 1 === 1 ? 'reserva' : 'reservas'}).</span>
                      )}
                    </div>
                  );
                })()}

                {/* Si no se ha elegido familia/proveedor, mostrar recuadro prominente de selección */}
                {!family ? (
                  <div className="group-family-prompt-box" data-testid="family-prompt-box">
                    <div className="group-prompt-icon">👆</div>
                    <h3 className="group-prompt-title">Selecciona un Proveedor de Modelos Arriba</h3>
                    <p className="group-prompt-desc">
                      Elige una familia (Google Gemini, Anthropic Claude, OpenAI Codex u otros) para comenzar a estructurar el pool soberano, asignar la cuenta titular en RAM y configurar su modelo especialista aislado.
                    </p>
                  </div>
                ) : leaderCandidates.length < 2 ? (
                  /* RECUADRO PROMINENTE DE CAPACIDAD INSUFICIENTE (0 o 1 cuenta libre) */
                  leaderCandidates.length === 0 ? (
                    <div className="group-capacity-notice-box zero-accounts" data-testid="capacity-notice-zero">
                      <div className="group-capacity-notice-title">
                        <span>🚫</span>
                        <span>No hay cuentas libres disponibles para {allModelFamilies[family]?.label || family}</span>
                      </div>
                      <p className="group-capacity-notice-desc">
                        Todas las cuentas registradas de este proveedor ya están operando dentro de pools activos, o aún no has vinculado ninguna credencial física/OAuth en CPAMC.
                      </p>
                      <p className="group-capacity-notice-desc" style={{ marginBottom: 16 }}>
                        Para armar un nuevo pool soberano de <strong>{allModelFamilies[family]?.label || family}</strong>, necesitas al menos <strong>2 cuentas libres</strong> (1 Titular + 1 Suplente). Puedes liberar cuentas en la pestaña <em>"Disolver / Adoptar Reservas"</em> o vincular una nueva en CPAMC.
                      </p>
                      <button
                        type="button"
                        className="btn-goto-dissolve-prominent"
                        onClick={() => setActiveTab('dissolve')}
                        data-testid="btn-goto-dissolve-from-zero"
                      >
                        <span>💥</span>
                        <span>Ir a la Pestaña "Disolver / Adoptar Reservas" para Liberar Cuentas</span>
                      </button>
                    </div>
                  ) : (
                    /* Caso: 1 sola cuenta libre detectada */
                    (() => {
                      const singleAccount = leaderCandidates[0]?.node;
                      const rawEmail = singleAccount?.data?.email || singleAccount?.name || singleAccount?.id || 'Desconocido';
                      const fileName = singleAccount?.data?.fileName || singleAccount?.id || '';
                      const isOmniAuth =
                        singleAccount?.data?.provider?.toLowerCase()?.includes('omni') ||
                        fileName.startsWith('omni_') ||
                        (singleAccount?.data?.accountType || '').toLowerCase().includes('omni') ||
                        Boolean(singleAccount?.data?.isOmniAuth);
                      const originLabel = isOmniAuth ? 'OmniAuth Pro' : 'CPAMC Nativo';
                      const originClass = isOmniAuth ? 'origin-omni' : 'origin-native';

                      return (
                        <div className="group-capacity-notice-box one-account" data-testid="capacity-notice-one">
                          <div className="group-capacity-notice-title">
                            <span>⚠️</span>
                            <span>Se requiere un mínimo de 2 cuentas para armar un Pool de rotación (Tienes 1)</span>
                          </div>

                          <p className="group-capacity-notice-desc">
                            Actualmente solo dispones de <strong>1 cuenta libre</strong> registrada para <strong>{allModelFamilies[family]?.label || family}</strong>:
                          </p>

                          {/* Tarjeta de Cuenta Detectada Dinámicamente */}
                          <div className="capacity-detected-account-card" data-testid="card-detected-single-account">
                            <div className="detected-account-left">
                              <span>👤</span>
                              <span>Cuenta detectada:</span>
                              <span className="detected-account-email" data-testid="detected-account-email">{rawEmail}</span>
                            </div>
                            <span className={`detected-account-origin ${originClass}`} data-testid="detected-account-origin">
                              {originLabel}
                            </span>
                          </div>

                          <div className="group-capacity-notice-rules">
                            Un pool soberano de balanceo y alta disponibilidad exige obligatoriamente:
                            <div style={{ marginTop: 6 }}>
                              • 👑 <strong>1 Cuenta Titular</strong> (Líder Activo en RAM que atiende las peticiones)<br />
                              • 🛡️ <strong>Al menos 1 Suplente de respaldo</strong> para relevar automáticamente ante cuotas agotadas (HTTP 429)
                            </div>
                          </div>

                          <p className="group-capacity-notice-desc" style={{ marginBottom: 16 }}>
                            ¿Tienes cuentas asignadas en otros pools? Puedes liberar suplentes en la pestaña <em>"Disolver / Adoptar"</em>, o vincular una 2ª cuenta para este proveedor en CPAMC.
                          </p>

                          <button
                            type="button"
                            className="btn-goto-dissolve-prominent"
                            onClick={() => setActiveTab('dissolve')}
                            data-testid="btn-goto-dissolve-from-one"
                          >
                            <span>💥</span>
                            <span>Ir a la Pestaña "Disolver / Adoptar Reservas" para Liberar Cuentas</span>
                          </button>
                        </div>
                      );
                    })()
                  )
                ) : (
                  <>
                    {/* Estructuración de Grupo & Pool en 2 columnas: Solo se muestra si hay 2 o más cuentas libres */}
                    <div className="group-structuring-grid">
                  {/* Columna Izquierda: Titular y Banco de Suplentes */}
                  <div className="group-col-accounts">
                    <div className="group-field group-field-account">
                      <label className="group-label">
                        <span>👑</span>
                        <span>Titular del Pool (Líder Activo en RAM):</span>
                      </label>
                      <select
                        className="group-select"
                        value={selectedActiveNodeId}
                        disabled={!family || leaderCandidates.length === 0}
                        onChange={(e) => handleSelectActiveNode(e.target.value)}
                        data-testid="select-active-account"
                      >
                        <option value="">
                          {family
                            ? (leaderCandidates.length === 0 ? '-- Sin cuentas disponibles para esta familia --' : '-- Selecciona la cuenta titular libre --')
                            : '⚠️ Elige primero la familia de modelos'}
                        </option>
                        {leaderCandidates.map(({ node: n, virtual }) => {
                          const email = n.data?.email || n.data?.fileName || n.id;
                          const prov = (n.data?.provider || n.data?.accountType || 'ANTIGRAVITY').toUpperCase();
                          return (
                            <option key={n.id} value={n.id}>
                              {virtual ? '🔀 ' : '👑 '}{email} ({prov}){virtual ? ' — copia' : ''}
                            </option>
                          );
                        })}
                      </select>
                      <p className="group-field-hint">Esta cuenta encabezará la rotación inicial del pool soberano.</p>
                    </div>

                    {/* Input de prefijo y chips ocultos visualmente pero accesibles en DOM para compatibilidad y tests */}
                    <div style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', border: 0 }}>
                      <input
                        type="text"
                        className="group-input"
                        placeholder={
                          effectiveFamily
                            ? `ej. ${effectiveFamily.hintPrefix}, ${effectiveFamily.hintPrefix}2`
                            : "ej. agy, agy2, agy_clau, codex"
                        }
                        value={groupBasePrefix}
                        onChange={(e) => {
                          setGroupBasePrefix(e.target.value);
                          setErrorMessage('');
                        }}
                        data-testid="input-group-base-prefix"
                      />
                      {familyMismatch && (
                        <div className="group-family-warning" data-testid="prefix-family-warning">
                          ⚠️ {familyMismatch.message}
                        </div>
                      )}
                      <div className="group-prefix-chips">
                        <span style={{ fontSize: 11, color: '#64748b', alignSelf: 'center' }}>Sugerido:</span>
                        {effectiveFamily && (
                          <button
                            type="button"
                            className="group-prefix-chip"
                            onClick={() => setGroupBasePrefix(suggestNextBasePrefix(nodes, effectiveFamily.hintPrefix))}
                          >
                            {suggestNextBasePrefix(nodes, effectiveFamily.hintPrefix)} (próximo libre)
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Cuentas de Respaldo */}
                    <div className="group-field">
                      <label className="group-label">
                        <span>🛡️</span>
                        <span>Cuentas de Respaldo (Rotación automática):</span>
                      </label>
                      {reserveCandidates.length === 0 ? (
                        <div style={{ color: '#64748b', fontSize: 12, padding: 8 }}>
                          {selectedActiveNodeId
                            ? 'No hay más cuentas libres compatibles con esta familia para rotación.'
                            : family
                              ? 'Selecciona primero una cuenta principal.'
                              : 'Elige primero la familia de modelos.'}
                        </div>
                      ) : (
                        <>
                          <p className="group-field-hint" style={{ marginTop: 2, marginBottom: 8 }}>
                            Selecciona las cuentas que tomarán el relevo si la principal agota su cuota:
                          </p>
                          <div className="group-reserves-container" data-testid="reserves-container">
                            {reserveCandidates.map(({ node: n, virtual }) => {
                              const isChecked = selectedReserveNodeIds.includes(n.id);
                              const email = n.data?.email || n.data?.fileName || n.id;
                              const file = n.data?.fileName || '';
                              const reserveIdx = selectedReserveNodeIds.indexOf(n.id);
                              return (
                                <div
                                  key={n.id}
                                  className={`group-reserve-item ${isChecked ? 'selected' : ''}`}
                                  onClick={() => handleToggleReserve(n.id)}
                                  data-testid={`reserve-item-${n.id}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => {}}
                                    style={{ cursor: 'pointer' }}
                                  />
                                  <div className="group-reserve-label">
                                    <span className="group-reserve-email">
                                      {virtual ? '🔀 ' : ''}{email}
                                    </span>
                                    <span className="group-reserve-sub">{file}</span>
                                  </div>
                                  {isChecked && (
                                    <span className="bento-reserve-order-badge">
                                      🛡️ #{reserveIdx + 1} Respaldo
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Columna Derecha: Modelo Especialista Aislado */}
                  <div className="group-col-specialist">
                    {family && (
                      <div
                        className="group-model-policy-card bento-specialist-card"
                        data-testid="model-policy-card"
                      >
                        <div className="bento-specialist-header">
                          <div className="bento-specialist-title">
                            <span className="bento-specialist-icon">🎯</span>
                            <span>MODELO ESPECIALISTA AISLADO</span>
                          </div>
                        </div>
                        <select
                          className="group-select bento-select"
                          value={selectedSpecialistModel}
                          disabled={!selectedActiveNodeId || availableSpecialistModels.length === 0}
                          onChange={(e) => setSelectedSpecialistModel(e.target.value)}
                          data-testid="select-specialist-model"
                        >
                          {!selectedActiveNodeId ? (
                            <option value="">-- Selecciona primero la cuenta titular en RAM --</option>
                          ) : (
                            <option value="">-- Selecciona el modelo especialista --</option>
                          )}
                          {availableSpecialistModels.map((m, idx) => (
                            <option key={m} value={m}>
                              {m}{idx === 0 ? ' ⭐ (Recomendado)' : ''}
                            </option>
                          ))}
                        </select>
                        {!selectedActiveNodeId ? (
                          <p className="bento-specialist-hint" style={{ color: '#94a3b8' }}>
                            🔒 Selecciona primero una cuenta titular (líder en RAM) para desplegar y habilitar sus modelos especialistas disponibles.
                          </p>
                        ) : availableSpecialistModels.length === 0 ? (
                          <p className="bento-specialist-hint" style={{ color: '#f59e0b' }}>
                            ⚠️ No hay cuentas vinculadas ni modelos disponibles en CPAMC para {effectiveFamily?.label || 'esta familia'}.
                          </p>
                        ) : !selectedSpecialistModel ? (
                          <p className="bento-specialist-hint" style={{ color: '#38bdf8' }}>
                            👉 Elige el modelo específico de esta cuenta que este pool atenderá de forma exclusiva.
                          </p>
                        ) : (
                          <p className="bento-specialist-hint">
                            🔒 Este pool responderá <strong>únicamente</strong> a <code>{selectedSpecialistModel}</code>. Los restantes {Math.max(0, availableSpecialistModels.length - 1)} modelos de su familia quedan automáticamente bloqueados para aislar la cuota.
                          </p>
                        )}
                        {/* Casilla 5.5 solo visible para familias de Claude donde existe dicha versión */}
                        {effectiveFamily && (effectiveFamily.key.includes('claude') || effectiveFamily.key.includes('sonnet') || effectiveFamily.key.includes('opus')) && (
                          <label className="bento-checkbox-label">
                            <input
                              type="checkbox"
                              data-testid="checkbox-exclude-55"
                              checked={excludeVersion55}
                              onChange={(e) => setExcludeVersion55(e.target.checked)}
                            />
                            <span>Excluir versiones 5.5 (Mantener solo versión 4.6 / Estable)</span>
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Acciones & Indicadores de Capacidad */}
                {selectedActiveNodeId && selectedReserveNodeIds.length === 0 && (
                  <div className="group-family-warning" style={{ marginTop: 8 }} data-testid="min-reserves-warning">
                    ⚠️ <strong>Mínimo 2 cuentas requeridas:</strong> Cada grupo de rotación debe tener 1 líder + al menos 1 reserva. Selecciona al menos 1 cuenta de reserva arriba.
                  </div>
                )}
                {selectedActiveNodeId && selectedReserveNodeIds.length > 0 && (
                  <div className="group-pool-ready-banner" data-testid="pool-ready-banner">
                    ✨ <strong>Pool listo para crear:</strong> 1 líder + {selectedReserveNodeIds.length} reserva(s) ({1 + selectedReserveNodeIds.length} cuentas en rotación).
                  </div>
                )}

                <div className="group-actions-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={
                      isSubmitting ||
                      !family ||
                      !selectedActiveNodeId ||
                      selectedReserveNodeIds.length < 1 ||
                      !groupBasePrefix.trim() ||
                      !!familyMismatch
                    }
                    onClick={handleInitiateCreateGroup}
                    data-testid="btn-save-group"
                    style={{
                      padding: '10px 20px',
                      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                      border: 'none',
                      color: '#fff',
                      fontWeight: 700,
                      borderRadius: 8,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span>✓</span>
                    <span>{isSubmitting ? 'Guardando...' : 'Armar y Guardar Pool'}</span>
                  </button>
                </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Columna Derecha: Vista Previa de Topología + Panel de Errores + Rutas Aisladas */}
          <div className="group-preview-col">
            {/* Panel de fallos parciales con reintento */}
            {saveReport && saveReport.failed.length > 0 && (
              <div className="group-card group-card-error" data-testid="pool-save-errors">
                <h3 className="group-card-title">
                  <span>⚠️</span>
                  <span>Pool "{saveReport.base}" guardado con errores parciales</span>
                </h3>
                <div className="group-save-report">
                  {saveReport.successful.map((s) => (
                    <div key={`ok-${s.name}`} className="group-save-row ok">
                      ✅ <span className="group-mono">[{s.prefix}]</span> → {s.name}
                    </div>
                  ))}
                  {saveReport.failed.map((f) => (
                    <div key={`fail-${f.name}`} className="group-save-row fail">
                      ❌ <span className="group-mono">[{f.prefix}]</span> → {f.name}
                      <span className="group-save-error">{f.error}</span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn-outline group-retry-btn"
                  disabled={isSubmitting}
                  onClick={handleRetryFailed}
                  data-testid="btn-retry-failed"
                >
                  🔄 Reintentar {saveReport.failed.length} cuenta(s) fallida(s)
                </button>
              </div>
            )}

            {/* Panel de rutas de acceso aislado */}
            {modelRoutes && modelRoutes.routes.length > 0 && (
              <div className="group-card group-card-routes" data-testid="model-routes-panel">
                <h3 className="group-card-title">
                  <span>🔐</span>
                  <span>Rutas de Acceso Aislado — pool "{modelRoutes.base}"</span>
                </h3>
                <p className="group-routes-hint">
                  Usa estas rutas <strong>prefijo/modelo</strong> para que las peticiones de tus clientes sirvan solo las cuentas de este pool.
                </p>
                <div className="group-routes-list">
                  {modelRoutes.routes.map((route) => (
                    <div key={route} className="group-route-row">
                      <code className="group-route-code">{route}</code>
                      <button
                        type="button"
                        className="group-copy-btn"
                        onClick={() => handleCopyRoute(route)}
                        data-testid={`btn-copy-route`}
                      >
                        {copiedRoute === route ? '✓ Copiado' : '📋 Copiar'}
                      </button>
                    </div>
                  ))}
                </div>
                <div className="group-route-example">
                  <span className="group-routes-hint">Ejemplo de llamada:</span>
                  <pre className="group-mono">{`POST /v1/chat/completions\n{ "model": "${modelRoutes.routes[0]}", ... }`}</pre>
                </div>
                <div className="group-routes-warning">
                  ⚠️ Si tus clientes usan el modelo base sin prefijo, la petición rota entre todas las cuentas — la cuota NO se aísla.
                </div>
              </div>
            )}

            <div className="group-card">
              <h3 className="group-card-title">
                <span>👁️</span>
                <span>Previsualización en Vivo de la Cascada</span>
              </h3>

              {!selectedActiveNodeId ? (
                <div style={{ textAlign: 'center', padding: '32px 16px', color: '#64748b', fontSize: 13 }}>
                  Selecciona una cuenta principal y prefijo para ver la jerarquía resultante.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* Nodo Principal */}
                  <div className="group-preview-node root" data-testid="preview-node-root">
                    <span className="group-preview-badge root">👑 Principal</span>
                    <span className="group-preview-code">
                      {groupBasePrefix || 'prefijo_base'}
                    </span>
                    <span style={{ fontSize: 12, color: '#cbd5e1', marginLeft: 'auto' }}>
                      {nodes.find((n) => n.id === selectedActiveNodeId)?.data?.email || 'cuenta'}
                    </span>
                  </div>

                  {/* Nodos de Reserva (numeración anti-colisión) */}
                  {(() => {
                    const previewAssigned = new Set();
                    return selectedReserveNodeIds.map((resId, idx) => {
                      const resNode = nodes.find((n) => n.id === resId);
                      const reserveNum = groupBasePrefix.trim()
                        ? nextReserveNumber(nodes, groupBasePrefix.trim(), previewAssigned)
                        : idx + 1;
                      if (groupBasePrefix.trim()) {
                        previewAssigned.add(`${groupBasePrefix.trim()}_${reserveNum}`);
                      }
                    return (
                      <div
                        key={resId}
                        className="group-preview-node"
                        style={{ marginLeft: 20 }}
                        data-testid={`preview-node-reserve-${idx}`}
                      >
                        <span className="group-preview-badge reserve">
                          ↳ 🛡️ Reserva {idx + 1}
                        </span>
                        <span className="group-preview-code">
                          {groupBasePrefix ? `${groupBasePrefix}_${reserveNum}` : `_${reserveNum}`}
                        </span>
                        <span style={{ fontSize: 12, color: '#cbd5e1', marginLeft: 'auto' }}>
                          {resNode?.data?.email || resNode?.data?.fileName}
                        </span>
                      </div>
                    );
                    });
                  })()}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pestaña: Disolver / ➕ Sumar / Adoptar Reservas */}
      {activeTab === 'dissolve' && (
        <div className="group-pools-grid" data-testid="dissolve-pools-grid">
          {existingPools.length === 0 ? (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 48, color: '#94a3b8' }}>
              No se detectaron pools estructurados en el sistema actualmente.
            </div>
          ) : (
            existingPools.map((pool, poolIdx) => {
              const poolProv = getPoolProvider(pool);
              const poolCleanName = pool.displayName || `Pool-${String(poolIdx + 1).padStart(2, '0')}-${poolProv || 'pool'}`;
              const defaultModel = poolProv === 'claude'
                ? 'claude-sonnet-4-6'
                : poolProv === 'codex'
                ? 'gpt-4o'
                : poolProv === 'nvidia' || poolProv === 'nim'
                ? 'meta/llama-3.3-70b-instruct'
                : 'gemini-3.8-flash-high';
              const leaderFile = pool.root?.data?.fileName || pool.root?.name || pool.root?.id || '';
              const leaderModel = (pool.memberModels && pool.memberModels[leaderFile]) || pool.targetModel || defaultModel;
              const leaderPref = pool.root?.data?.prefix || pool.basePrefix;
              const compatibleFreeNodes = freeNodes.filter((fn) => getNodeProvider(fn) === poolProv);

              return (
              <div key={pool.id || pool.basePrefix} className="group-pool-card" data-testid={`pool-card-${pool.basePrefix}`}>
                <div className="group-pool-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#38bdf8', background: 'rgba(56, 189, 248, 0.12)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(56, 189, 248, 0.3)' }}>
                      📦 {poolCleanName}
                    </span>
                    <h4 className="group-pool-title">{pool.basePrefix}</h4>
                    <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', background: 'rgba(148, 163, 184, 0.1)', padding: '2px 6px', borderRadius: 4 }} title="En /model aparece limpio como este identificador">
                      /model: {poolCleanName}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontSize: 11,
                        background: 'rgba(14, 165, 233, 0.12)',
                        color: '#38bdf8',
                        padding: '2px 8px',
                        borderRadius: 4,
                        border: '1px solid rgba(56, 189, 248, 0.25)',
                        fontFamily: 'monospace',
                        fontWeight: 600,
                      }}
                      title="Modelo Especialista Predeterminado del Pool"
                    >
                      ⚙️ {pool.targetModel || defaultModel}
                    </span>
                    <span style={{ fontSize: 11, background: 'rgba(168, 85, 247, 0.2)', color: '#d8b4fe', padding: '2px 8px', borderRadius: 4, fontWeight: 700 }}>
                      {(pool.root ? 1 : 0) + pool.reserves.length} cuentas
                    </span>
                  </div>
                </div>

                <div className="group-pool-members">
                  {pool.root && (
                    <div className="group-pool-member-row">
                      <div className="group-pool-member-top">
                        <div className="group-pool-member-identity">
                          <span style={{ color: '#fbbf24', flexShrink: 0 }}>1️⃣ 👑</span>
                          <span className="group-pool-member-email" style={{ color: '#fbbf24' }} title={pool.root.data?.email || pool.root.data?.fileName}>
                            {pool.root.data?.email || pool.root.data?.fileName}
                          </span>
                        </div>
                        <div className="group-pool-member-badges">
                          <span style={{
                            fontSize: 9,
                            fontWeight: 800,
                            background: 'rgba(234, 179, 8, 0.25)',
                            color: '#fef08a',
                            padding: '2px 6px',
                            borderRadius: 4,
                            border: '1px solid rgba(234, 179, 8, 0.4)',
                          }}
                          title="Líder dinámico ficticio en RAM: Auto Switcher Pro rota este rol automáticamente según disponibilidad y anti-429"
                          >
                            LEADER
                          </span>
                          <span style={{
                            fontSize: 9,
                            fontWeight: 700,
                            background: 'rgba(56, 189, 248, 0.15)',
                            color: '#38bdf8',
                            padding: '2px 6px',
                            borderRadius: 4,
                            border: '1px solid rgba(56, 189, 248, 0.35)',
                          }}>
                            🔄 DINÁMICO
                          </span>
                          <button
                            type="button"
                            onClick={() => handleReleaseLeader(pool.basePrefix, pool.root)}
                            disabled={isSubmitting}
                            title="Liberar líder del pool y promover primera reserva"
                            data-testid={`btn-release-leader-${pool.basePrefix}`}
                            style={{
                              background: 'rgba(239, 68, 68, 0.12)',
                              border: '1px solid rgba(239, 68, 68, 0.3)',
                              color: '#fca5a5',
                              borderRadius: 4,
                              padding: '1px 6px',
                              fontSize: 10,
                              fontWeight: 700,
                              cursor: 'pointer',
                              marginLeft: 2,
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="group-pool-member-bottom">
                        <span className="group-pool-member-model" title={`Especialista: ${leaderModel}`}>
                          ⚙️ {leaderModel}
                        </span>
                        <span className="group-pool-member-prefix" style={{ color: '#fbbf24', fontWeight: 700 }}>
                          [{leaderPref || pool.basePrefix}]
                        </span>
                      </div>
                    </div>
                  )}
                  {pool.reserves.map(({ node, prefix }, rIdx) => {
                    const rFile = node.data?.fileName || node.name || node.id || '';
                    const rModel = (pool.memberModels && pool.memberModels[rFile]) || pool.targetModel || defaultModel;
                    const numBadge = rIdx === 0 ? '2️⃣' : rIdx === 1 ? '3️⃣' : `${rIdx + 2}️⃣`;
                    return (
                    <div key={node.id} className="group-pool-member-row">
                      <div className="group-pool-member-top">
                        <div className="group-pool-member-identity">
                          <span style={{ color: '#7dd3fc', flexShrink: 0 }}>{numBadge} 🛡️</span>
                          <span className="group-pool-member-email" style={{ color: '#7dd3fc' }} title={node.data?.email || node.data?.fileName}>
                            {node.data?.email || node.data?.fileName}
                          </span>
                        </div>
                        <div className="group-pool-member-badges">
                          <span style={{
                            fontSize: 9,
                            fontWeight: 700,
                            background: 'rgba(125, 211, 252, 0.15)',
                            color: '#7dd3fc',
                            padding: '2px 6px',
                            borderRadius: 4,
                            border: '1px solid rgba(125, 211, 252, 0.3)',
                          }}>
                            RESERVA {rIdx + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleReleaseReserve(pool.basePrefix, node)}
                            disabled={isSubmitting}
                            title="Liberar solo esta cuenta de reserva sin disolver el pool"
                            data-testid={`btn-release-reserve-${pool.basePrefix}-${node.id}`}
                            style={{
                              background: 'rgba(239, 68, 68, 0.12)',
                              border: '1px solid rgba(239, 68, 68, 0.3)',
                              color: '#fca5a5',
                              borderRadius: 4,
                              padding: '1px 6px',
                              fontSize: 10,
                              fontWeight: 700,
                              cursor: 'pointer',
                              marginLeft: 2,
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="group-pool-member-bottom">
                        <span className="group-pool-member-model" style={{ color: '#7dd3fc', background: 'rgba(14, 165, 233, 0.08)', borderColor: 'rgba(125, 211, 252, 0.25)' }} title={`Especialista: ${rModel}`}>
                          ⚙️ {rModel}
                        </span>
                        <span className="group-pool-member-prefix">
                          [{prefix || `${pool.basePrefix}_${rIdx + 1}`}]
                        </span>
                      </div>
                    </div>
                  );
                  })}

                  {/* Fila Final: Adoptar / Sumar Reservas directamente en la lista de miembros (solo cuentas compatibles del mismo proveedor) */}
                  {compatibleFreeNodes.length > 0 && (
                    <div
                      className="group-pool-member-row"
                      data-testid={`card-adopt-section-${pool.basePrefix}`}
                      style={{
                        background: 'linear-gradient(180deg, rgba(2, 6, 23, 0.75) 0%, rgba(15, 23, 42, 0.85) 100%)',
                        border: '1px solid rgba(56, 189, 248, 0.4)',
                        boxShadow: '0 4px 16px rgba(2, 132, 199, 0.15)',
                        padding: '12px 14px',
                        gap: 10,
                        marginTop: 4,
                      }}
                    >
                      <div className="group-pool-member-top" style={{ borderBottom: '1px solid rgba(56, 189, 248, 0.2)', paddingBottom: 6 }}>
                        <div className="group-pool-member-identity">
                          <span style={{ color: '#38bdf8', fontSize: 13, flexShrink: 0 }}>➕ 🛡️</span>
                          <span style={{ fontSize: 12, color: '#f0f9ff', fontWeight: 800, letterSpacing: '0.02em' }}>
                            SUMAR NUEVA RESERVA AL POOL
                          </span>
                        </div>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            background: 'rgba(56, 189, 248, 0.15)',
                            color: '#7dd3fc',
                            padding: '2px 8px',
                            borderRadius: 4,
                            border: '1px solid rgba(56, 189, 248, 0.3)',
                          }}
                        >
                          1 POOL = 1 MODELO
                        </span>
                      </div>

                      {/* Selector y Modelo que hereda */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 8 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            🔑 Cuenta Libre Disponible
                          </span>
                          <select
                            className="group-select"
                            style={{
                              width: '100%',
                              padding: '7px 10px',
                              fontSize: 11,
                              background: '#090d16',
                              borderColor: 'rgba(56, 189, 248, 0.3)',
                              color: '#f8fafc',
                              borderRadius: 6,
                            }}
                            value={cardAdoptSelections[pool.basePrefix] || compatibleFreeNodes[0]?.id || ''}
                            onChange={(e) =>
                              setCardAdoptSelections((prev) => ({
                                ...prev,
                                [pool.basePrefix]: e.target.value,
                              }))
                            }
                            data-testid={`select-card-adopt-${pool.basePrefix}`}
                          >
                            {compatibleFreeNodes.map((fn) => (
                              <option key={fn.id} value={fn.id}>
                                🔑 {fn.data?.email || fn.data?.fileName || fn.id}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontSize: 10, color: '#38bdf8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            🎯 Modelo que Heredará
                          </span>
                          <div
                            style={{
                              padding: '6px 10px',
                              background: 'rgba(14, 165, 233, 0.08)',
                              border: '1px solid rgba(56, 189, 248, 0.25)',
                              borderRadius: 6,
                              fontSize: 11,
                              color: '#e0f2fe',
                              fontFamily: 'monospace',
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                            title={`Hereda automáticamente ${pool.targetModel || defaultModel}`}
                          >
                            <span>🔒</span>
                            <span>{pool.targetModel || defaultModel} ⭐</span>
                          </div>
                        </div>
                      </div>

                      {/* Footer de la acción con botón llamativo */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingTop: 4 }}>
                        <span style={{ fontSize: 10.5, color: '#94a3b8', lineHeight: 1.3 }}>
                          ℹ️ Se sumará como siguiente reserva respondiendo ante 429 o fatiga.
                        </span>
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => {
                            const selId = cardAdoptSelections[pool.basePrefix] || compatibleFreeNodes[0]?.id;
                            const targetNode = compatibleFreeNodes.find((fn) => fn.id === selId) || compatibleFreeNodes[0];
                            if (targetNode) {
                              handleAdoptAccountIntoPool(pool.basePrefix, targetNode);
                            }
                          }}
                          data-testid={`btn-card-adopt-${pool.basePrefix}`}
                          style={{
                            background: 'linear-gradient(135deg, #0284c7 0%, #2563eb 100%)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 6,
                            padding: '7px 16px',
                            fontSize: 11.5,
                            fontWeight: 700,
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            boxShadow: '0 2px 10px rgba(2, 132, 199, 0.35)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            flexShrink: 0,
                          }}
                        >
                          <span>➕</span>
                          <span>Sumar Reserva</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => handleDissolvePool(pool)}
                  disabled={isSubmitting}
                  className="btn btn-outline"
                  data-testid={`btn-dissolve-pool-${pool.basePrefix}`}
                  style={{
                    marginTop: 10,
                    borderColor: 'rgba(239, 68, 68, 0.4)',
                    color: '#f87171',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    padding: '8px 12px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: 'rgba(239, 68, 68, 0.1)',
                  }}
                >
                  <span>💥</span>
                  <span>Disolver Pool (Liberar Cuentas)</span>
                </button>
              </div>
              );
            })
          )}
        </div>
      )}

      {/* Modal de Comunicado Especial y Aporte Voluntario Comunitario al Crear Pool */}
      <CommunityNoticeModal
        isOpen={isNoticeOpen}
        onClose={handleNoticeCloseAndContinue}
      />
    </div>
  );
}
