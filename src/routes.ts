import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { rolesRouter } from './modules/access/roles.routes.js';
import { providersRouter, verificationRouter } from './modules/providers/providers.routes.js';
import { catalogueRouter } from './modules/catalogue/catalogue.routes.js';
import { discoveryRouter } from './modules/discovery/discovery.routes.js';
import { affiliationsRouter } from './modules/affiliations/affiliations.routes.js';
import { appointmentsRouter } from './modules/appointments/appointments.routes.js';
import { financeRouter } from './modules/finance/finance.routes.js';
import { manualFinanceRouter } from './modules/finance/manual.routes.js';
import { diagnosticsRouter } from './modules/diagnostics/diagnostics.routes.js';
import { pharmacyRouter } from './modules/pharmacy/pharmacy.routes.js';
import { ambulanceRouter } from './modules/ambulance/ambulance.routes.js';
import { supportRouter } from './modules/support/support.routes.js';
import { platformRouter } from './modules/platform/platform.routes.js';
import { integrationsRouter } from './modules/platform/integrations.routes.js';
import { geoRouter } from './modules/geo/geo.routes.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { exportsRouter } from './modules/exports/exports.routes.js';

/** Mounts every module router under /api/v1. */
export function apiRouter(): Router {
  const r = Router();
  r.use(authRouter());
  r.use(usersRouter());
  r.use(rolesRouter());
  r.use(providersRouter());
  r.use(verificationRouter());
  r.use(catalogueRouter());
  r.use(discoveryRouter());
  r.use(affiliationsRouter());
  r.use(appointmentsRouter());
  r.use(financeRouter());
  r.use(manualFinanceRouter());
  r.use(diagnosticsRouter());
  r.use(pharmacyRouter());
  r.use(ambulanceRouter());
  r.use(supportRouter());
  r.use(platformRouter());
  r.use(integrationsRouter());
  r.use(geoRouter());
  r.use(analyticsRouter());
  r.use(exportsRouter());
  return r;
}
