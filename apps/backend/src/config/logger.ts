import * as winston from 'winston';
import 'winston-daily-rotate-file';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_DIR = process.env.LOG_DIR || 'logs';

const sensitiveKeys = ['password', 'secret', 'token', 'authorization', 'apiKey', 'secretKey'];

const redactSensitive = winston.format((info) => {
  const redacted = { ...info };
  for (const key of Object.keys(redacted)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s.toLowerCase()))) {
      (redacted as Record<string, unknown>)[key] = '[REDACTED]';
    }
  }
  return redacted;
});

const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    redactSensitive(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
      return `${timestamp} [${level}]: ${message} ${metaStr}`;
    })
  ),
});

const fileTransports: winston.transport[] = [];

if (process.env.NODE_ENV === 'production') {
  fileTransports.push(
    new winston.transports.DailyRotateFile({
      filename: `${LOG_DIR}/application-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: winston.format.combine(
        winston.format.timestamp(),
        redactSensitive(),
        winston.format.json()
      ),
    }),
    new winston.transports.DailyRotateFile({
      filename: `${LOG_DIR}/error-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        redactSensitive(),
        winston.format.json()
      ),
    })
  );
}

const logger = winston.createLogger({
  level: LOG_LEVEL,
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
  },
  format: winston.format.combine(
    winston.format.timestamp(),
    redactSensitive(),
    winston.format.json()
  ),
  transports: [consoleTransport, ...fileTransports],
});

export default logger;
