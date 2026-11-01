import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';

// A single shared metrics instance avoids recreating EMF configuration on warm invocations.
const metrics = new Metrics({ namespace: 'Auctions', serviceName: 'auctions' });

export async function recordBusinessMetric(name: string): Promise<void> {
  metrics.addMetric(name, MetricUnit.Count, 1);
  await metrics.publishStoredMetrics();
}
