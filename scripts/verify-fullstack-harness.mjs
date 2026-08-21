const apiBaseUrl = process.env.API_BASE_URL ?? 'http://api:4000';
const frontendBaseUrl = process.env.FRONTEND_BASE_URL ?? 'http://frontend:3000';
const frontendPublicOrigin = process.env.FRONTEND_PUBLIC_ORIGIN ?? 'http://localhost:3000';

const frontendHealth = await fetch(`${frontendBaseUrl}/api/health`);
if (!frontendHealth.ok) throw new Error(`Frontend health failed: ${frontendHealth.status}`);
const frontendHealthBody = await frontendHealth.json();
if (frontendHealthBody?.status !== 'ok' || frontendHealthBody?.service !== 'danangmap-frontend') {
  throw new Error('Frontend health payload does not identify danangmap-frontend');
}

const homepage = await fetch(frontendBaseUrl);
if (!homepage.ok) throw new Error(`Frontend homepage failed: ${homepage.status}`);
const homepageHtml = await homepage.text();
if (!homepageHtml.includes('__next') && !homepageHtml.includes('/_next/')) {
  throw new Error('Frontend homepage is not a rendered Next.js document');
}

const readiness = await fetch(`${apiBaseUrl}/health/ready`);
if (!readiness.ok) throw new Error(`API readiness failed: ${readiness.status}`);

const catalog = await fetch(`${apiBaseUrl}/api/v1/public/layers`, {
  headers: { Origin: frontendPublicOrigin },
});
if (!catalog.ok) throw new Error(`Public catalog failed: ${catalog.status}`);
if (catalog.headers.get('access-control-allow-origin') !== frontendPublicOrigin) {
  throw new Error('API CORS contract does not allow the real frontend origin');
}
const catalogBody = await catalog.json();
if (!catalogBody?.data?.some((layer) => layer?.slug === 'schools')) {
  throw new Error('Seeded public catalog is unavailable to the full-stack harness');
}

console.log(
  JSON.stringify({
    status: 'ok',
    frontend: frontendHealthBody.service,
    api: 'ready',
    catalogLayers: catalogBody.data.length,
    demoMode: false,
  }),
);
