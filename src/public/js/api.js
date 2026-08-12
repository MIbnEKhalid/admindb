/* Tiny JSON API client. Every request resolves to the `data` payload of the
 * consistent { success, data?, error? } envelope, or throws with the message. */
(function () {
  'use strict';
  const base = (window.APP && window.APP.basePath) || '';

  function url(path) {
    return base + path;
  }

  window.Api = {
    basePath: base,
    url: url,

    async request(method, path, body) {
      const opts = { method, headers: {} };
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      let res;
      try {
        res = await fetch(url(path), opts);
      } catch (e) {
        throw new Error('Network error: ' + e.message);
      }
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      if (!res.ok) {
        throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
      }
      if (!data || data.success === false) {
        throw new Error((data && data.error) || 'Request failed');
      }
      return data.data;
    },

    get(path) { return this.request('GET', path); },
    post(path, body) { return this.request('POST', path, body); },
    put(path, body) { return this.request('PUT', path, body); },
    del(path) { return this.request('DELETE', path); },
  };
})();
