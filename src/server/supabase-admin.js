// Operações do servidor que exigem a chave service_role do Supabase. A chave
// nunca vai ao navegador; sem ela, estes recursos ficam desativados.
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };

export function createAdminClient({ supabaseUrl, serviceRoleKey }) {
  return supabaseUrl && serviceRoleKey ? createClient(supabaseUrl, serviceRoleKey, clientOptions) : null;
}

// Links curtos de cenário (/c/<id>). O id é derivado do conteúdo: o mesmo
// cenário sempre gera o mesmo link.
export function createSharedScenarioStore(adminClient) {
  return {
    enabled: Boolean(adminClient),
    async save(payload) {
      const id = createHash('sha256').update(JSON.stringify(payload)).digest('base64url').slice(0, 10);
      const { error } = await adminClient
        .from('shared_scenarios')
        .upsert({ id, payload }, { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      return id;
    },
    async load(id) {
      const { data, error } = await adminClient.from('shared_scenarios').select('payload').eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.payload || null;
    },
  };
}

export function createAccountDeleter({ supabaseUrl, publicKey, adminClient, logger = console }) {
  return async function deleteAccount(token) {
    if (!adminClient || !publicKey) {
      return { status: 503, body: { error: 'Exclusão de conta não está configurada no servidor.' } };
    }
    try {
      const authClient = createClient(supabaseUrl, publicKey, clientOptions);
      const { data, error: authError } = await authClient.auth.getUser(token);
      if (authError || !data.user)
        return { status: 401, body: { error: 'Sessão inválida ou expirada. Entre novamente.' } };
      const { error } = await adminClient.auth.admin.deleteUser(data.user.id);
      if (error) throw error;
      return { status: 200, body: { deleted: true } };
    } catch (error) {
      logger.error('Supabase account deletion failed:', error instanceof Error ? error.message : error);
      return { status: 502, body: { error: 'O provedor não conseguiu excluir a conta. Tente novamente.' } };
    }
  };
}
