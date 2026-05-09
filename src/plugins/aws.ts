import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { KinesisVideoClient } from '@aws-sdk/client-kinesis-video';
import { KMSClient } from '@aws-sdk/client-kms';
import { IoTClient } from '@aws-sdk/client-iot';
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { S3Client } from '@aws-sdk/client-s3';
import { SESClient } from '@aws-sdk/client-ses';
import { env } from '@config/env';
import { setRekognitionClient } from '@services/rekognition.service';
import { setS3Client } from '@services/s3.service';
import { setSesClient } from '@services/ses.service';

export default fp(async function awsPlugin(app: FastifyInstance) {
  const kvs = new KinesisVideoClient({ region: env.AWS_REGION });
  const kms = new KMSClient({ region: env.AWS_REGION });
  const iot = new IoTClient({ region: env.AWS_REGION });
  const rekognition = new RekognitionClient({ region: env.AWS_REGION });
  const s3 = new S3Client({ region: env.AWS_REGION });
  const ses = new SESClient({ region: env.SES_REGION });

  // Set clients on service modules
  setRekognitionClient(rekognition);
  setS3Client(s3);
  setSesClient(ses);

  app.decorate('kvs', kvs);
  app.decorate('kms', kms);
  app.decorate('iot', iot);
  app.decorate('rekognition', rekognition);
  app.decorate('s3', s3);
  app.decorate('ses', ses);

  app.addHook('onClose', async () => {
    kvs.destroy();
    kms.destroy();
    iot.destroy();
    rekognition.destroy();
    s3.destroy();
    ses.destroy();
  });
});
