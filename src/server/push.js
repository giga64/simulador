// Notificações push de jogos dos clubes favoritos (início, gol, fim).
// Precisa de VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT e da chave
// service_role do Supabase (para ler favoritos e inscrições de todos os usuários).
import webPush from 'web-push';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function isValidPushSubscription(subscription) {
  try {
    const url = new URL(subscription?.endpoint);
    return (
      url.protocol === 'https:' &&
      subscription.endpoint.length <= 1000 &&
      typeof subscription.keys?.p256dh === 'string' &&
      typeof subscription.keys?.auth === 'string' &&
      BASE64URL.test(subscription.keys.p256dh) &&
      BASE64URL.test(subscription.keys.auth) &&
      subscription.keys.p256dh.length <= 200 &&
      subscription.keys.auth.length <= 100
    );
  } catch {
    return false;
  }
}

export function pushMessage(event, teamNames) {
  const home = teamNames[event.home];
  const away = teamNames[event.away];
  const score = `${home} ${event.homeGoals} x ${event.awayGoals} ${away}`;
  if (event.type === 'start') return { title: 'Começou!', body: `${home} x ${away}` };
  if (event.type === 'end') return { title: 'Fim de jogo', body: score };
  return { title: `Gol ${event.side === 'home' ? `do ${home}` : `do ${away}`}!`, body: score };
}

export function createPushNotifier({ vapid, adminClient, teamNames, logger = console, sender = webPush }) {
  const enabled = Boolean(vapid?.publicKey && vapid?.privateKey && vapid?.subject && adminClient);
  if (enabled) sender.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const sent = new Set();

  async function subscriptionsFor(teams) {
    const { data: preferences, error } = await adminClient
      .from('user_preferences')
      .select('user_id')
      .overlaps('favorite_teams', teams);
    if (error) throw new Error(error.message);
    const userIds = preferences.map((row) => row.user_id);
    if (!userIds.length) return [];
    const { data, error: subscriptionError } = await adminClient
      .from('push_subscriptions')
      .select('endpoint,p256dh,auth')
      .in('user_id', userIds);
    if (subscriptionError) throw new Error(subscriptionError.message);
    return data;
  }

  return {
    enabled,
    publicKey: enabled ? vapid.publicKey : '',
    async notify(events) {
      if (!enabled) return 0;
      let delivered = 0;
      for (const event of events) {
        const key = `${event.fixtureId}:${event.type}:${event.homeGoals}-${event.awayGoals}`;
        if (sent.has(key)) continue;
        sent.add(key);
        const payload = JSON.stringify({
          ...pushMessage(event, teamNames),
          tag: `jogo-${event.fixtureId}`,
          url: '/?view=live',
        });
        let subscriptions = [];
        try {
          subscriptions = await subscriptionsFor([event.home, event.away]);
        } catch (error) {
          logger.error(`Push: não foi possível ler as inscrições: ${error.message}`);
          continue;
        }
        await Promise.all(
          subscriptions.map(async (row) => {
            try {
              await sender.sendNotification(
                { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
                payload,
                { TTL: 600, urgency: 'high' },
              );
              delivered++;
            } catch (error) {
              // 404/410: inscrição expirada ou cancelada no navegador.
              if (error?.statusCode === 404 || error?.statusCode === 410) {
                await adminClient.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
              } else logger.error(`Push: falha no envio (${error?.statusCode || error?.message})`);
            }
          }),
        );
      }
      return delivered;
    },
  };
}
