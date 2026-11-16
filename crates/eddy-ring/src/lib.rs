//! Wait-free SPSC ring buffer. One `Producer`, one `Consumer`, each owned by one thread.
//! No allocation or locking after construction, so it is safe on audio threads.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

struct Inner<T> {
    buf: Box<[UnsafeCell<T>]>,
    mask: usize,
    head: AtomicUsize, // next write position (monotonic)
    tail: AtomicUsize, // next read position (monotonic)
}

// Safety: producer only writes slots in [tail+cap.., head), consumer only reads [tail, head);
// the atomics with Acquire/Release order hand slots over between the two threads.
unsafe impl<T: Send> Send for Inner<T> {}
unsafe impl<T: Send> Sync for Inner<T> {}

pub struct Producer<T> { inner: Arc<Inner<T>> }
pub struct Consumer<T> { inner: Arc<Inner<T>> }

/// Capacity is rounded up to a power of two.
pub fn ring<T: Copy + Default>(min_capacity: usize) -> (Producer<T>, Consumer<T>) {
    let cap = min_capacity.max(2).next_power_of_two();
    let buf = (0..cap).map(|_| UnsafeCell::new(T::default())).collect::<Vec<_>>().into_boxed_slice();
    let inner = Arc::new(Inner { buf, mask: cap - 1, head: AtomicUsize::new(0), tail: AtomicUsize::new(0) });
    (Producer { inner: inner.clone() }, Consumer { inner })
}

impl<T: Copy> Producer<T> {
    pub fn capacity(&self) -> usize { self.inner.mask + 1 }

    pub fn free(&self) -> usize {
        let h = self.inner.head.load(Ordering::Relaxed);
        let t = self.inner.tail.load(Ordering::Acquire);
        self.capacity() - h.wrapping_sub(t)
    }

    pub fn push(&mut self, v: T) -> bool {
        self.push_slice(std::slice::from_ref(&v)) == 1
    }

    /// Writes as many items as fit and returns the count written.
    pub fn push_slice(&mut self, data: &[T]) -> usize {
        let h = self.inner.head.load(Ordering::Relaxed);
        let t = self.inner.tail.load(Ordering::Acquire);
        let free = self.capacity() - h.wrapping_sub(t);
        let n = data.len().min(free);
        for (i, v) in data[..n].iter().enumerate() {
            unsafe { *self.inner.buf[(h.wrapping_add(i)) & self.inner.mask].get() = *v; }
        }
        self.inner.head.store(h.wrapping_add(n), Ordering::Release);
        n
    }
}

impl<T: Copy + Default> Consumer<T> {
    pub fn capacity(&self) -> usize { self.inner.mask + 1 }

    pub fn len(&self) -> usize {
        let h = self.inner.head.load(Ordering::Acquire);
        let t = self.inner.tail.load(Ordering::Relaxed);
        h.wrapping_sub(t)
    }

    pub fn is_empty(&self) -> bool { self.len() == 0 }

    pub fn pop(&mut self) -> Option<T> {
        let mut out = [T::default(); 1];
        if self.pop_slice(&mut out) == 1 { Some(out[0]) } else { None }
    }

    /// Reads up to `out.len()` items and returns the count read.
    pub fn pop_slice(&mut self, out: &mut [T]) -> usize {
        let h = self.inner.head.load(Ordering::Acquire);
        let t = self.inner.tail.load(Ordering::Relaxed);
        let n = out.len().min(h.wrapping_sub(t));
        for (i, o) in out[..n].iter_mut().enumerate() {
            *o = unsafe { *self.inner.buf[(t.wrapping_add(i)) & self.inner.mask].get() };
        }
        self.inner.tail.store(t.wrapping_add(n), Ordering::Release);
        n
    }

    /// Drops up to `n` items without reading them.
    pub fn skip(&mut self, n: usize) -> usize {
        let h = self.inner.head.load(Ordering::Acquire);
        let t = self.inner.tail.load(Ordering::Relaxed);
        let n = n.min(h.wrapping_sub(t));
        self.inner.tail.store(t.wrapping_add(n), Ordering::Release);
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_pop_wraps() {
        let (mut p, mut c) = ring::<u32>(4);
        for round in 0..10u32 {
            assert_eq!(p.push_slice(&[round, round + 100, round + 200]), 3);
            let mut out = [0u32; 3];
            assert_eq!(c.pop_slice(&mut out), 3);
            assert_eq!(out, [round, round + 100, round + 200]);
        }
        assert!(c.is_empty());
    }

    #[test]
    fn refuses_overflow_and_reports_partial() {
        let (mut p, mut c) = ring::<u8>(4);
        assert_eq!(p.push_slice(&[1, 2, 3, 4, 5, 6]), 4);
        assert_eq!(p.free(), 0);
        assert!(!p.push(9));
        assert_eq!(c.pop(), Some(1));
        assert!(p.push(9));
    }

    #[test]
    fn two_threads_preserve_order() {
        let (mut p, mut c) = ring::<u32>(1024);
        const N: u32 = 200_000;
        let prod = std::thread::spawn(move || {
            let mut i = 0;
            while i < N {
                if p.push(i) { i += 1 } else { std::thread::yield_now() }
            }
        });
        let mut expect = 0;
        while expect < N {
            match c.pop() {
                Some(v) => { assert_eq!(v, expect); expect += 1 }
                None => std::thread::yield_now(),
            }
        }
        prod.join().unwrap();
    }
}
