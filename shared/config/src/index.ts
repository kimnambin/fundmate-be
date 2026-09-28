export * from './lib/service-config.js';
export * from './lib/proxy-config.js';
export * from './lib/header-to-locals.js';
export * from './lib/http.js';
export * from './lib/password.js';
export * from './lib/rate-limit.js';
import { serviceConfig } from './lib/service-config.js';
import { ServiceClient } from './lib/proxy-config.js';

export const serviceClients: Record<string, ServiceClient> = Object.entries(serviceConfig).reduce(
  (acc, [name, cfg]) => {
    acc[name] = new ServiceClient(cfg);
    return acc;
  },
  {} as Record<string, ServiceClient>
);
