function validProjectUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname.endsWith('.supabase.co') &&
      url.pathname === '/' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.origin
      : '';
  } catch {
    return '';
  }
}

function isPublicApiKey(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('sb_publishable_')) return /^sb_publishable_[A-Za-z0-9_-]+$/.test(value);
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon';
  } catch {
    return false;
  }
}

export function getPublicSupabaseConfig(environment) {
  const supabaseUrl = validProjectUrl(environment.SUPABASE_URL);
  const candidate = environment.SUPABASE_PUBLISHABLE_KEY || environment.SUPABASE_ANON_KEY || '';
  const publicKey = isPublicApiKey(candidate);
  const authConfigured = Boolean(supabaseUrl && publicKey);
  return {
    supabaseUrl: authConfigured ? supabaseUrl : '',
    supabaseKey: authConfigured ? candidate : '',
    authConfigured,
    accountDeletionConfigured: isSupabaseServiceRoleKey(environment.SUPABASE_SERVICE_ROLE_KEY),
  };
}

export function isSupabaseServiceRoleKey(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'service_role';
  } catch {
    return false;
  }
}
