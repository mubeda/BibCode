//! Capacity policy for the persisted and in-memory authentication authority.

pub(crate) const MAX_ACTIVE_PAIRINGS: usize = 4_096;
pub(crate) const MAX_ACTIVE_PAIRING_OFFERS_PER_PRINCIPAL: usize = 128;
pub(crate) const MAX_ACTIVE_PAIRING_OFFERS: usize = 4_096;
pub(crate) const MAX_ACTIVE_SESSIONS: usize = 4_096;
