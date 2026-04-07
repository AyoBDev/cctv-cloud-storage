// src/services/iot.service.ts
import type { IoTClient } from '@aws-sdk/client-iot';
import {
  CreateThingCommand,
  DeleteThingCommand,
  CreateKeysAndCertificateCommand,
  UpdateCertificateCommand,
  DeleteCertificateCommand,
  AttachPolicyCommand,
  DetachPolicyCommand,
  AttachThingPrincipalCommand,
  DetachThingPrincipalCommand,
  DescribeEndpointCommand,
} from '@aws-sdk/client-iot';
import { env } from '@config/env';

const isTestEnv = () => env.NODE_ENV === 'test';

let cachedEndpoint: string | null = null;

export async function createIoTThing(
  iot: IoTClient,
  thingName: string,
): Promise<string> {
  if (isTestEnv()) {
    return `arn:aws:iot:eu-west-2:000000000000:thing/${thingName}`;
  }

  const result = await iot.send(
    new CreateThingCommand({ thingName }),
  );

  if (!result.thingArn) {
    throw new Error('CreateThing returned no ARN');
  }

  return result.thingArn;
}

export async function deleteIoTThing(
  iot: IoTClient,
  thingName: string,
  policyName: string,
  certId?: string | null,
  certArn?: string | null,
): Promise<void> {
  if (isTestEnv()) return;

  // If cert was issued, clean it up first (order matters)
  if (certArn && certId) {
    // 1. Detach cert from Thing
    await iot.send(
      new DetachThingPrincipalCommand({
        thingName,
        principal: certArn,
      }),
    );

    // 2. Detach policy from cert
    await iot.send(
      new DetachPolicyCommand({
        policyName,
        target: certArn,
      }),
    );

    // 3. Revoke cert
    await iot.send(
      new UpdateCertificateCommand({
        certificateId: certId,
        newStatus: 'INACTIVE',
      }),
    );

    // 4. Delete cert
    await iot.send(
      new DeleteCertificateCommand({
        certificateId: certId,
        forceDelete: true,
      }),
    );
  }

  // 5. Delete Thing
  await iot.send(
    new DeleteThingCommand({ thingName }),
  );
}

export interface IssuedCredentials {
  certificateId: string;
  certificateArn: string;
  certificatePem: string;
  privateKey: string;
}

export async function issueCredentials(
  iot: IoTClient,
  thingName: string,
  policyName: string,
): Promise<IssuedCredentials> {
  if (isTestEnv()) {
    return {
      certificateId: 'test-cert-id',
      certificateArn: `arn:aws:iot:eu-west-2:000000000000:cert/test-cert-id`,
      certificatePem: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nTEST\n-----END RSA PRIVATE KEY-----',
    };
  }

  // 1. Create cert + keys (set as active)
  const certResult = await iot.send(
    new CreateKeysAndCertificateCommand({ setAsActive: true }),
  );

  if (!certResult.certificateId || !certResult.certificateArn ||
      !certResult.certificatePem || !certResult.keyPair?.PrivateKey) {
    throw new Error('CreateKeysAndCertificate returned incomplete data');
  }

  const { certificateId, certificateArn, certificatePem } = certResult;
  const privateKey = certResult.keyPair.PrivateKey;

  // 2. Attach IoT policy to cert
  await iot.send(
    new AttachPolicyCommand({
      policyName,
      target: certificateArn,
    }),
  );

  // 3. Attach cert to Thing
  await iot.send(
    new AttachThingPrincipalCommand({
      thingName,
      principal: certificateArn,
    }),
  );

  return { certificateId, certificateArn, certificatePem, privateKey };
}

export async function getCredentialEndpoint(
  iot: IoTClient,
): Promise<string> {
  if (isTestEnv()) {
    return 'test-endpoint.credentials.iot.eu-west-2.amazonaws.com';
  }

  if (cachedEndpoint) return cachedEndpoint;

  const result = await iot.send(
    new DescribeEndpointCommand({ endpointType: 'iot:CredentialProvider' }),
  );

  if (!result.endpointAddress) {
    throw new Error('DescribeEndpoint returned no address');
  }

  cachedEndpoint = result.endpointAddress;
  return cachedEndpoint;
}
