// Minimal, color-coded logger for terminal output
// Each level gets its own color and prefix so scanning logs is effortless.

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

const COLORS = {
  info:  '\x1b[36m',   // cyan
  ok:    '\x1b[32m',   // green
  warn:  '\x1b[33m',   // yellow
  error: '\x1b[31m',   // red
  db:    '\x1b[35m',   // magenta
  http:  '\x1b[34m',   // blue
  dim:   '\x1b[90m',   // grey
};

function ts() {
  return DIM + new Date().toISOString().slice(11, 23) + RESET; // HH:MM:SS.mmm
}

function tag(level) {
  const color = COLORS[level] || RESET;
  const labels = {
    info:  'INFO ',
    ok:    ' OK  ',
    warn:  'WARN ',
    error: 'ERROR',
    db:    '  DB ',
    http:  'HTTP ',
    dim:   '     ',
  };
  return `${color}${BOLD}${labels[level] || level.toUpperCase()}${RESET}`;
}

function log(level, ...args) {
  const color = COLORS[level] || RESET;
  const parts = args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
  );
  console.log(`${ts()}  ${tag(level)}  ${color}${parts.join(' ')}${RESET}`);
}

const logger = {
  info:  (...a) => log('info',  ...a),
  ok:    (...a) => log('ok',    ...a),
  warn:  (...a) => log('warn',  ...a),
  error: (...a) => log('error', ...a),
  db:    (...a) => log('db',    ...a),
  http:  (...a) => log('http',  ...a),
  dim:   (...a) => log('dim',   ...a),

  // Startup banner — called once when server boots
  banner(port, dbPath) {
    const line = '─'.repeat(44);
    console.log(`\n\x1b[36m${line}${RESET}`);
    console.log(`  ${BOLD}MF Portfolio Viewer  —  API Server${RESET}`);
    console.log(`  ${COLORS.ok}●${RESET} Listening  ${BOLD}http://localhost:${port}${RESET}`);
    console.log(`  ${COLORS.db}●${RESET} Database   ${DIM}${dbPath}${RESET}`);
    console.log(`\x1b[36m${line}${RESET}\n`);
  },
};

export default logger;
