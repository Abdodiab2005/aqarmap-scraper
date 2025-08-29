// src/utils/logger.js
const pino = require("pino");

const level = process.env.LOG_LEVEL || "info";
const pretty = process.env.LOG_PRETTY === "1";

const transport = pretty
  ? {
      target: "pino-pretty",
      options: {
        translateTime: "SYS:standard",
        colorize: true,
        singleLine: false,
      },
    }
  : undefined;

const logger = pino(
  { level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
  transport ? pino.transport(transport) : undefined
);

module.exports = logger;
