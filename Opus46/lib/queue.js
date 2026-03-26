'use strict';

const MAX_SIZE    = parseInt(process.env.QUEUE_MAX_SIZE    || '10', 10);
const TIMEOUT_MS  = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10);
const MAX_RETRIES = 3;

class MessageQueue {
  constructor() {
    this._queue  = [];
    this._busy   = false;
    this._onIdle = null; // optional callback
  }

  get size()   { return this._queue.length; }
  get busy()   { return this._busy; }
  get isFull() { return this._queue.length >= MAX_SIZE; }

  // Returns a Promise that resolves with the task result.
  push(task, { retries = MAX_RETRIES } = {}) {
    if (this.isFull) {
      return Promise.reject(Object.assign(
        new Error(`queue_full: ${this._queue.length}/${MAX_SIZE}`),
        { code: 'queue_full', queueSize: this._queue.length }
      ));
    }

    return new Promise((resolve, reject) => {
      this._queue.push({ task, retries, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this._busy || this._queue.length === 0) return;
    const item = this._queue.shift();
    this._busy = true;
    this._run(item);
  }

  _run(item, attempt = 0) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error(`timeout after ${TIMEOUT_MS}ms`),
        { code: 'timeout' }
      )), TIMEOUT_MS);
    });

    Promise.race([item.task(), timeoutPromise])
      .then(result => {
        clearTimeout(timer);
        item.resolve(result);
        this._done();
      })
      .catch(err => {
        clearTimeout(timer);
        const isMiniMaxDown = /connect|ECONNREFUSED|ETIMEDOUT|unavailable/i.test(err.message);
        if (isMiniMaxDown && attempt < item.retries) {
          const delay = [5000, 15000, 45000][attempt] || 45000;
          console.warn(`[queue] retry ${attempt + 1}/${item.retries} in ${delay}ms — ${err.message}`);
          setTimeout(() => this._run(item, attempt + 1), delay);
        } else {
          item.reject(err);
          this._done();
        }
      });
  }

  _done() {
    this._busy = false;
    if (this._queue.length > 0) {
      this._pump();
    }
  }

  status() {
    return { busy: this._busy, size: this._queue.length, maxSize: MAX_SIZE };
  }
}

// Exportar la clase para que el bridge cree instancias por workspace
module.exports = MessageQueue;
