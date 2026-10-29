export class ConfigurationError extends Error {}

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('REPLACE_')) {
    throw new ConfigurationError(`Set ${name} to a non-empty value (not an example placeholder).`);
  }
  return value;
}

function port(value, name) {
  if (!/^\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new ConfigurationError(`${name} must be an integer between 1 and 65535.`);
  }
  return Number(value);
}

export function loadConfig(env = process.env) {
  const adminToken = required(env, 'ADMIN_TOKEN');
  // Bearer token syntax; a random hex token fits without quoting or escaping.
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(adminToken)) {
    throw new ConfigurationError('ADMIN_TOKEN must be a single Bearer token without whitespace.');
  }
  return {
    port: port(env.PORT ?? '3010', 'PORT'),
    adminToken,
    database: {
      host: required(env, 'PGHOST'),
      port: port(env.PGPORT ?? '5432', 'PGPORT'),
      database: required(env, 'PGDATABASE'),
      user: required(env, 'PGUSER'),
      password: required(env, 'PGPASSWORD'),
    },
  };
}
