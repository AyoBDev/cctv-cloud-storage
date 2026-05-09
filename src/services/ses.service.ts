import { SendEmailCommand, type SESClient } from '@aws-sdk/client-ses';
import { env } from '@config/env';

const isTestEnv = () => env.NODE_ENV === 'test';

let sesClient: SESClient | null = null;

export function setSesClient(client: SESClient): void {
  sesClient = client;
}

function getClient(): SESClient {
  if (!sesClient) throw new Error('SESClient not initialized');
  return sesClient;
}

export interface AlertEmailParams {
  toEmail: string;
  cameraName: string;
  thumbnailUrl: string;
  timestamp: string;
  orgId: string;
}

export async function sendUnknownFaceAlert(params: AlertEmailParams): Promise<void> {
  if (isTestEnv()) return;

  const client = getClient();
  await client.send(
    new SendEmailCommand({
      Source: env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [params.toEmail] },
      Message: {
        Subject: { Data: `Unknown face detected on ${params.cameraName}` },
        Body: {
          Html: {
            Data: `
              <h2>Unknown Face Detected</h2>
              <p><strong>Camera:</strong> ${params.cameraName}</p>
              <p><strong>Time:</strong> ${params.timestamp}</p>
              <p><img src="${params.thumbnailUrl}" alt="Detected face" style="max-width:300px" /></p>
              <p><a href="#">View recognition events</a></p>
            `,
          },
        },
      },
    }),
  );
}
