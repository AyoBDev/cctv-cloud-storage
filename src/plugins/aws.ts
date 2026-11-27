import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { KinesisVideoClient } from '@aws-sdk/client-kinesis-video';
import { KMSClient } from '@aws-sdk/client-kms';
import { IoTClient } from '@aws-sdk/client-iot';
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { S3Client } from '@aws-sdk/client-s3';
import { SESClient } from '@aws-sdk/client-ses';
import { SNSClient } from '@aws-sdk/client-sns';
import { MarketplaceMeteringClient } from '@aws-sdk/client-marketplace-metering';
import { MarketplaceEntitlementServiceClient } from '@aws-sdk/client-marketplace-entitlement-service';
import { MarketplaceAgreementClient } from '@aws-sdk/client-marketplace-agreement';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { env } from '@config/env';
import { setRekognitionClient } from '@services/rekognition.service';
import { setS3Client } from '@services/s3.service';
import { setSesClient } from '@services/ses.service';
import { createMarketplaceAccessSource } from '@services/marketplace-access-source';

const MARKETPLACE_ROLE_SESSION_NAME = 'olympusvisions-api-marketplace';

/**
 * Client settings for the AWS Marketplace APIs. These only work from the seller
 * account that published the listing, so when `sellerRoleArn` is set the clients
 * assume that role (credentials refresh automatically); otherwise they use the
 * default credential chain like every other client.
 */
export function marketplaceClientConfig(
  region: string,
  sellerRoleArn: string,
): { region: string; credentials?: ReturnType<typeof fromTemporaryCredentials> } {
  if (!sellerRoleArn) return { region };
  return {
    region,
    credentials: fromTemporaryCredentials({
      params: { RoleArn: sellerRoleArn, RoleSessionName: MARKETPLACE_ROLE_SESSION_NAME },
      clientConfig: { region },
    }),
  };
}

export default fp(async function awsPlugin(app: FastifyInstance) {
  const kvs = new KinesisVideoClient({ region: env.AWS_REGION });
  const kms = new KMSClient({ region: env.AWS_REGION });
  const iot = new IoTClient({ region: env.AWS_REGION });
  const rekognition = new RekognitionClient({ region: env.AWS_REGION });
  const s3 = new S3Client({ region: env.AWS_REGION });
  const ses = new SESClient({ region: env.SES_REGION });
  const sns = new SNSClient({ region: env.AWS_REGION });
  const marketplaceMetering = new MarketplaceMeteringClient(
    marketplaceClientConfig(env.AWS_REGION, env.MARKETPLACE_SELLER_ROLE_ARN),
  );
  const marketplaceEntitlement = new MarketplaceEntitlementServiceClient(
    marketplaceClientConfig(env.MARKETPLACE_ENTITLEMENT_REGION, env.MARKETPLACE_SELLER_ROLE_ARN),
  );
  const marketplaceAgreement = new MarketplaceAgreementClient(
    marketplaceClientConfig(env.MARKETPLACE_ENTITLEMENT_REGION, env.MARKETPLACE_SELLER_ROLE_ARN),
  );
  const marketplaceAccess = createMarketplaceAccessSource({
    pricingModel: env.MARKETPLACE_PRICING_MODEL,
    entitlementClient: marketplaceEntitlement,
    agreementClient: marketplaceAgreement,
    cameraDimension: env.MARKETPLACE_CAMERA_DIMENSION,
    freeCameraLimit: env.MARKETPLACE_FREE_CAMERA_LIMIT,
  });

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
  app.decorate('sns', sns);
  app.decorate('marketplaceMetering', marketplaceMetering);
  app.decorate('marketplaceEntitlement', marketplaceEntitlement);
  app.decorate('marketplaceAgreement', marketplaceAgreement);
  app.decorate('marketplaceAccess', marketplaceAccess);

  app.addHook('onClose', async () => {
    kvs.destroy();
    kms.destroy();
    iot.destroy();
    rekognition.destroy();
    s3.destroy();
    ses.destroy();
    sns.destroy();
    marketplaceMetering.destroy();
    marketplaceEntitlement.destroy();
    marketplaceAgreement.destroy();
  });
});
