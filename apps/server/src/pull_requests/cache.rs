//! Bounded, request-driven memoization of successful host context observations.
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    hash::Hash,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub(super) const TTL: Duration = Duration::from_secs(30);
const CAPACITY: usize = 32;
type Slot<V> = Arc<tokio::sync::Mutex<Option<(Instant, V)>>>;

#[derive(Debug)]
struct Entries<K, V> {
    values: HashMap<K, Slot<V>>,
    order: VecDeque<K>,
}

#[derive(Debug)]
pub(super) struct ContextCache<K, V> {
    entries: Mutex<Entries<K, V>>,
}

impl<K, V> Default for ContextCache<K, V> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(Entries {
                values: HashMap::new(),
                order: VecDeque::new(),
            }),
        }
    }
}

impl<K: Clone + Eq + Hash, V: Clone> ContextCache<K, V> {
    pub(super) fn clear(&self) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        entries.values.clear();
        entries.order.clear();
    }

    /// Detaches one key; an in-flight load for it cannot repopulate the map.
    pub(super) fn remove(&self, key: &K) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if entries.values.remove(key).is_some() {
            entries.order.retain(|known| known != key);
        }
    }

    pub(super) fn get(&self, key: &K) -> Option<V> {
        let slot = self
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values
            .get(key)?
            .clone();
        let entry = slot.try_lock().ok()?;
        entry
            .as_ref()
            .filter(|(at, _)| at.elapsed() < TTL)
            .map(|(_, value)| value.clone())
    }

    pub(super) async fn get_or_load<E>(
        &self,
        key: K,
        cancellation: &CancellationToken,
        cancelled: impl Fn() -> E,
        load: impl Future<Output = Result<V, E>>,
    ) -> Result<V, E> {
        let slot = {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(slot) = entries.values.get(&key) {
                slot.clone()
            } else {
                if entries.values.len() == CAPACITY
                    && let Some(oldest) = entries.order.pop_front()
                {
                    entries.values.remove(&oldest);
                }
                let slot = Arc::new(tokio::sync::Mutex::new(None));
                entries.order.push_back(key.clone());
                entries.values.insert(key, slot.clone());
                slot
            }
        };
        let mut entry = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            entry = slot.lock() => entry,
        };
        if let Some((at, value)) = &*entry
            && at.elapsed() < TTL
        {
            return Ok(value.clone());
        }
        let observed_at = Instant::now();
        let value = load.await?;
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        // clear/eviction detach the slot; an old in-flight load cannot repopulate the map.
        *entry = Some((observed_at, value.clone()));
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn pull_requests_cache_expires_bounds_capacity_and_never_caches_errors() {
        let cache = ContextCache::default();
        let c = CancellationToken::new();
        assert_eq!(
            cache
                .get_or_load(1, &c, || "cancelled", async { Err::<u32, _>("failure") })
                .await,
            Err("failure")
        );
        assert_eq!(cache.get(&1), None);
        assert_eq!(
            cache
                .get_or_load(1, &c, || "cancelled", async { Ok(1) })
                .await,
            Ok(1)
        );
        tokio::time::advance(TTL).await;
        assert_eq!(cache.get(&1), None);
        assert_eq!(
            cache
                .get_or_load(1, &c, || "cancelled", async { Ok(2) })
                .await,
            Ok(2)
        );
        for key in 2..=33 {
            cache
                .get_or_load(key, &c, || "cancelled", async { Ok(key) })
                .await
                .unwrap();
        }
        assert_eq!(cache.get(&1), None);
        assert_eq!(cache.entries.lock().unwrap().values.len(), CAPACITY);
        c.cancel();
        assert_eq!(
            cache
                .get_or_load(33, &c, || "cancelled", async { Ok(99) })
                .await,
            Err("cancelled")
        );
    }

    #[tokio::test]
    async fn pull_requests_cache_coalesces_loads_and_clear_fences_inflight_publication() {
        let cache = ContextCache::default();
        let c = CancellationToken::new();
        let started = tokio::sync::Notify::new();
        let release = tokio::sync::Notify::new();
        let first = cache.get_or_load(1, &c, || "cancelled", async {
            started.notify_one();
            release.notified().await;
            Ok(1)
        });
        let second = async {
            started.notified().await;
            release.notify_one();
            cache
                .get_or_load(1, &c, || "cancelled", async {
                    panic!("duplicate context load")
                })
                .await
        };
        let (a, b) = tokio::join!(first, second);
        assert_eq!((a, b), (Ok(1), Ok(1)));
        cache.clear();
        let first = cache.get_or_load(1, &c, || "cancelled", async {
            started.notify_one();
            release.notified().await;
            Ok(2)
        });
        let rescan = async {
            started.notified().await;
            cache.clear();
            cache
                .get_or_load(1, &c, || "cancelled", async { Ok(3) })
                .await
                .unwrap();
            release.notify_one();
        };
        let (result, ()) = tokio::join!(first, rescan);
        assert_eq!(result, Ok(2));
        assert_eq!(cache.get(&1), Some(3));
    }

    #[tokio::test(start_paused = true)]
    async fn pull_requests_cache_slow_load_and_cancelled_waiter_do_not_extend_or_poison_answers() {
        let cache = ContextCache::default();
        let c = CancellationToken::new();
        cache
            .get_or_load(1, &c, || "cancelled", async {
                tokio::time::advance(TTL).await;
                Ok(1)
            })
            .await
            .unwrap();
        assert_eq!(
            cache.get(&1),
            None,
            "the bound starts at observation, not late completion"
        );
        let started = tokio::sync::Notify::new();
        let release = tokio::sync::Notify::new();
        let waiter_c = CancellationToken::new();
        let owner = cache.get_or_load(2, &c, || "cancelled", async {
            started.notify_one();
            release.notified().await;
            Ok(2)
        });
        let waiter = async {
            started.notified().await;
            let wait = cache.get_or_load(2, &waiter_c, || "cancelled", async {
                panic!("cancelled waiter loaded")
            });
            let cancel = async {
                waiter_c.cancel();
            };
            let (result, ()) = tokio::join!(wait, cancel);
            assert_eq!(result, Err("cancelled"));
            release.notify_one();
        };
        let (result, ()) = tokio::join!(owner, waiter);
        assert_eq!(result, Ok(2));
        assert_eq!(cache.get(&2), Some(2));
    }
}
