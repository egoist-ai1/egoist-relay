use std::{
  collections::VecDeque,
  time::{Duration, Instant},
};

const MAX_PENDING: usize = 6;
const MAX_WAIT: Duration = Duration::from_secs(45);
const MAX_RECENT: usize = 24;
const DUPLICATE_WINDOW: Duration = Duration::from_secs(4);

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Offer<T> {
  Accepted,
  Duplicate(T),
  Full(T),
}

pub(super) struct PendingNotices<T> {
  entries: VecDeque<(Instant, T)>,
  recent: VecDeque<(Instant, u64)>,
}

impl<T> PendingNotices<T> {
  pub(super) const fn new() -> Self {
    Self { entries: VecDeque::new(), recent: VecDeque::new() }
  }

  pub(super) fn offer(&mut self, value: T, now: Instant, key: Option<u64>) -> Offer<T> {
    while self.recent.front().is_some_and(|(seen, _)| now.saturating_duration_since(*seen) >= DUPLICATE_WINDOW) {
      self.recent.pop_front();
    }
    if key.is_some_and(|key| self.recent.iter().any(|(_, seen)| *seen == key)) {
      return Offer::Duplicate(value);
    }
    if self.entries.len() >= MAX_PENDING {
      return Offer::Full(value);
    }
    if let Some(key) = key {
      if self.recent.len() >= MAX_RECENT {
        self.recent.pop_front();
      }
      self.recent.push_back((now, key));
    }
    self.entries.push_back((now, value));
    Offer::Accepted
  }

  pub(super) fn pop(&mut self) -> Option<T> {
    self.entries.pop_front().map(|(_, value)| value)
  }

  pub(super) fn expire(&mut self, now: Instant) -> impl Iterator<Item = T> + use<T> {
    let count = self.entries.iter()
      .take_while(|(queued, _)| now.saturating_duration_since(*queued) >= MAX_WAIT)
      .count();
    self.entries.drain(..count).map(|(_, value)| value).collect::<Vec<_>>().into_iter()
  }

  pub(super) fn drain(&mut self) -> impl Iterator<Item = T> + use<T> {
    self.recent.clear();
    std::mem::take(&mut self.entries).into_iter().map(|(_, value)| value)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accepts_six_and_retains_fifo_order() {
    let now = Instant::now();
    let mut pending = PendingNotices::new();
    let accepted: Vec<_> = (0..8).filter(|value| pending.offer(*value, now, None) == Offer::Accepted).collect();
    assert_eq!(accepted, vec![0, 1, 2, 3, 4, 5]);
    let delivered: Vec<_> = std::iter::from_fn(|| pending.pop()).collect();
    assert_eq!(accepted, delivered);
  }

  #[test]
  fn drops_expired_notices_before_presenting_the_next_one() {
    let now = Instant::now();
    let mut pending = PendingNotices::new();
    assert_eq!(pending.offer(1, now, None), Offer::Accepted);
    assert_eq!(pending.offer(2, now + Duration::from_secs(1), None), Offer::Accepted);
    assert_eq!(pending.expire(now + MAX_WAIT).collect::<Vec<_>>(), vec![1]);
    assert_eq!(pending.pop(), Some(2));
  }

  #[test]
  fn lock_drains_the_queue_before_new_notices() {
    let now = Instant::now();
    let mut pending = PendingNotices::new();
    assert_eq!(pending.offer("before lock", now, Some(1)), Offer::Accepted);
    assert_eq!(pending.drain().collect::<Vec<_>>(), vec!["before lock"]);
    assert_eq!(pending.pop(), None);
    assert_eq!(pending.offer("after lock", now, Some(1)), Offer::Accepted);
    assert_eq!(pending.pop(), Some("after lock"));
  }

  #[test]
  fn duplicate_is_coalesced_while_queued_and_after_delivery_only_within_window() {
    let now = Instant::now();
    let mut pending = PendingNotices::new();
    assert_eq!(pending.offer(1, now, Some(8)), Offer::Accepted);
    assert_eq!(pending.offer(1, now, Some(8)), Offer::Duplicate(1));
    assert_eq!(pending.pop(), Some(1));
    assert_eq!(pending.offer(1, now + Duration::from_secs(1), Some(8)), Offer::Duplicate(1));
    assert_eq!(pending.offer(2, now, Some(9)), Offer::Accepted);
    assert_eq!(pending.offer(1, now + DUPLICATE_WINDOW, Some(8)), Offer::Accepted);
  }

  #[test]
  fn full_queue_does_not_record_rejected_notification_as_duplicate() {
    let now = Instant::now();
    let mut pending = PendingNotices::new();
    for value in 0..MAX_PENDING {
      assert_eq!(pending.offer(value, now, None), Offer::Accepted);
    }
    assert_eq!(pending.offer(8, now, Some(8)), Offer::Full(8));
    assert_eq!(pending.pop(), Some(0));
    assert_eq!(pending.offer(8, now, Some(8)), Offer::Accepted);
  }
}
