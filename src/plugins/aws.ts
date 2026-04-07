import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { KinesisVideoClient } from '@aws-sdk/client-kinesis-video';
import { KMSClient } from '@aws-sdk/client-kms';
import { IoTClient } from '@aws-sdk/client-iot';
import { env } from '@config/env';

export default fp(async function awsPlugin(app: FastifyInstance) {
  const kvs = new KinesisVideoClient({ region: env.AWS_REGION });
  const kms = new KMSClient({ region: env.AWS_REGION });
  const iot = new IoTClient({ region: env.AWS_REGION });

  app.decorate('kvs', kvs);
  app.decorate('kms', kms);
  app.decorate('iot', iot);

  app.addHook('onClose', async () => {
    kvs.destroy();
    kms.destroy();
    iot.destroy();
  });
});
