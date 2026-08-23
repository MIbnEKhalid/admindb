/* Shared Common Utilities for AdminDB Frontend:
 * HTML escaping, data type detectors, formatting, clipboard, download, and SQL syntax highlighting. */
(function (root) {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isJson(s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return false;
    try {
      JSON.parse(t);
      return true;
    } catch (e) {
      return false;
    }
  }

  function isHexBlob(s) {
    return typeof s === 'string' && /^0x[0-9a-f]{4,}$/i.test(s.trim());
  }

  function formatBytes(bytes) {
    var b = Number(bytes);
    if (isNaN(b) || b < 0) return '0 B';
    if (b < 1024) return b + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var u = -1;
    do {
      b /= 1024;
      u++;
    } while (b >= 1024 && u < units.length - 1);
    return b.toFixed(b < 10 ? 1 : 0) + ' ' + units[u];
  }

  function formatNumber(num) {
    var n = Number(num);
    if (isNaN(n)) return String(num || '0');
    return n.toLocaleString();
  }

  function copyToClipboard(text, successMsg) {
    if (!text) return Promise.resolve();
    return navigator.clipboard.writeText(text).then(function () {
      if (root.UI && root.UI.showToast && successMsg) {
        root.UI.showToast(successMsg, 'success');
      }
    });
  }

  function downloadBlob(blob, filename) {
    if (!blob) return;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function debounce(fn, waitMs) {
    var timer = null;
    return function () {
      var context = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(context, args);
      }, waitMs || 200);
    };
  }

  function throttle(fn, limitMs) {
    var inThrottle = false;
    return function () {
      var context = this;
      var args = arguments;
      if (!inThrottle) {
        fn.apply(context, args);
        inThrottle = true;
        setTimeout(function () {
          inThrottle = false;
        }, limitMs || 200);
      }
    };
  }

  // Token-based SQL syntax highlighter
  var SQL_TOKEN_REGEX = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*')|("(?:""|[^"])*")|(\b\d+(?:\.\d+)?\b)|(\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|ON|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|INSERT\s+INTO|INSERT|INTO|VALUES|UPDATE|SET|DELETE\s+FROM|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|DROP|CREATE|ALTER|TABLE|VIEW|INDEX|TRIGGER|PRIMARY\s+KEY|FOREIGN\s+KEY|REFERENCES|CASCADE|RESTRICT|SET\s+NULL|CHECK|CONSTRAINT|UNIQUE|DEFAULT|NOT\s+NULL|NULL|IS\s+NOT\s+NULL|IS\s+NULL|IS|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|ILIKE|GLOB|MATCH|REGEXP|AS|DISTINCT|ALL|UNION\s+ALL|UNION|INTERSECT|EXCEPT|CASE|WHEN|THEN|ELSE|END|RETURNING|WITH|RECURSIVE|TRANSACTION|BEGIN|COMMIT|ROLLBACK|PRAGMA|EXPLAIN|ASC|DESC|TRUE|FALSE)\b)|(\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|IFNULL|LENGTH|LOWER|UPPER|SUBSTR|SUBSTRING|TRIM|LTRIM|RTRIM|ROUND|ABS|RANDOM|HEX|UNHEX|QUOTE|TYPEOF|INSTR|PRINTF|FORMAT|STRFTIME|DATE|TIME|DATETIME|JULIANDAY|UNIXEPOCH|NOW|JSON|JSON_EXTRACT|JSON_ARRAY|JSON_OBJECT|JSONB|GEN_RANDOM_UUID|CONCAT)\b)|(\b(?:INTEGER|INT|BIGINT|SMALLINT|TINYINT|TEXT|VARCHAR|CHAR|CLOB|REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC|BOOLEAN|BOOL|TIMESTAMP|TIMESTAMPTZ|BLOB|BYTEA|JSON|JSONB|UUID|SERIAL|BIGSERIAL)\b)|(<=|>=|!=|<>|=|<|>|\+|-|\*|\/|%|\|\|)|([,;()])/gi;

  function highlightSql(sql) {
    if (!sql) return '';
    var out = '';
    var lastIndex = 0;
    var match;

    while ((match = SQL_TOKEN_REGEX.exec(sql)) !== null) {
      if (match.index > lastIndex) {
        out += escapeHtml(sql.slice(lastIndex, match.index));
      }
      var text = match[0];
      if (match[1]) {
        out += '<span class="sql-tok-comment">' + escapeHtml(text) + '</span>';
      } else if (match[2] || match[3]) {
        out += '<span class="sql-tok-str">' + escapeHtml(text) + '</span>';
      } else if (match[4]) {
        out += '<span class="sql-tok-num">' + escapeHtml(text) + '</span>';
      } else if (match[5]) {
        out += '<span class="sql-tok-kw">' + escapeHtml(text) + '</span>';
      } else if (match[6]) {
        out += '<span class="sql-tok-fn">' + escapeHtml(text) + '</span>';
      } else if (match[7]) {
        out += '<span class="sql-tok-type">' + escapeHtml(text) + '</span>';
      } else if (match[8]) {
        out += '<span class="sql-tok-op">' + escapeHtml(text) + '</span>';
      } else if (match[9]) {
        out += '<span class="sql-tok-punc">' + escapeHtml(text) + '</span>';
      }
      lastIndex = match.index + text.length;
    }
    if (lastIndex < sql.length) {
      out += escapeHtml(sql.slice(lastIndex));
    }
    return out;
  }

  var SQLITE_TYPES = [
    'TEXT',
    'INTEGER',
    'REAL',
    'BLOB',
    'BOOLEAN',
    'DATE',
    'DATETIME',
    'NUMERIC',
    'VARCHAR(255)',
    'JSON'
  ];

  var POSTGRES_TYPES = [
    'TEXT',
    'VARCHAR(255)',
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'SERIAL',
    'BIGSERIAL',
    'REAL',
    'DECIMAL(10,2)',
    'NUMERIC',
    'BOOLEAN',
    'DATE',
    'DATETIME',
    'TIMESTAMP',
    'TIMESTAMPTZ',
    'TIME',
    'INTERVAL',
    'JSON',
    'JSONB',
    'UUID',
    'BYTEA',
    'INET'
  ];

  var NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_$]*$/;

  function isPostgres(customDialect) {
    if (customDialect) return customDialect.toLowerCase() === 'postgres' || customDialect.toLowerCase() === 'postgresql';
    return !!(root.APP && (root.APP.dialect === 'postgres' || root.APP.dialect === 'postgresql'));
  }

  function getDesignerTypes(customDialect) {
    return isPostgres(customDialect) ? POSTGRES_TYPES : SQLITE_TYPES;
  }

  function toLocalInput(v, type) {
    if (v == null || v === '') return '';
    var s = String(v);
    var t = (type || '').toUpperCase();

    if (t === 'DATE') {
      var dm = s.match(/^(\d{4}-\d{2}-\d{2})/);
      return dm ? dm[1] : s;
    }

    if (t === 'TIME' || t === 'TIMETZ' || t.startsWith('TIME ') || t.startsWith('TIME(')) {
      var tm = s.match(/(\d{2}:\d{2}(?::\d{2})?)/);
      return tm ? tm[1] : s;
    }

    var m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return m[1] + 'T' + m[2] + ':' + m[3] + (m[4] ? ':' + m[4] : '');
    return s;
  }

  function toLocalNow(dateOnly, timeOnly) {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    if (dateOnly) {
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    if (timeOnly) {
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  var Utils = {
    escapeHtml: escapeHtml,
    isJson: isJson,
    isHexBlob: isHexBlob,
    formatBytes: formatBytes,
    formatNumber: formatNumber,
    copyToClipboard: copyToClipboard,
    downloadBlob: downloadBlob,
    debounce: debounce,
    throttle: throttle,
    highlightSql: highlightSql,
    SQLITE_TYPES: SQLITE_TYPES,
    POSTGRES_TYPES: POSTGRES_TYPES,
    getDesignerTypes: getDesignerTypes,
    isPostgres: isPostgres,
    NAME_REGEX: NAME_REGEX,
    toLocalInput: toLocalInput,
    toLocalNow: toLocalNow,
  };

  root.Utils = Utils;

  // Also attach to window.UI for backward-compatibility
  root.UI = root.UI || {};
  root.UI.escapeHtml = escapeHtml;
  root.UI.isJson = isJson;
  root.UI.isHexBlob = isHexBlob;
  root.UI.formatBytes = formatBytes;
  root.UI.formatNumber = formatNumber;
  root.UI.copyToClipboard = copyToClipboard;
  root.UI.downloadBlob = downloadBlob;
  root.UI.debounce = debounce;
  root.UI.throttle = throttle;
  root.UI.highlightSql = highlightSql;
  root.UI.SQLITE_TYPES = SQLITE_TYPES;
  root.UI.POSTGRES_TYPES = POSTGRES_TYPES;
  root.UI.getDesignerTypes = getDesignerTypes;
  root.UI.isPostgres = isPostgres;
  root.UI.NAME_REGEX = NAME_REGEX;
  root.UI.toLocalInput = toLocalInput;
  root.UI.toLocalNow = toLocalNow;
})(window);
