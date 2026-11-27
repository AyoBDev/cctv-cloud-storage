# Marketplace seller account stack

The AWS Marketplace listing belongs to a **seller account** that is separate from the **app account**, where ECS and the Lambdas run. This stack runs in the seller account. It:

1. Creates the `marketplace-api-access` role. Only the app's ECS task role can assume it. It allows only `aws-marketplace:ResolveCustomer`, `aws-marketplace:GetEntitlements` and `aws-marketplace:DescribeAgreement` (free listings have no entitlements, so access follows the agreement status).
2. Adds an EventBridge rule in `us-east-1` that forwards the listing's agreement and license events to the app account's `us-east-1` default event bus. From there the app stack sends them on to the API.

```
seller us-east-1 default bus ──rule──▶ app us-east-1 default bus ──rule──▶ app eu-west-1 default bus ──▶ SQS ──▶ Lambda ──▶ API
```

## Apply

1. Get two values from the app team: `app_task_role_arn` and `app_event_bus_arn`. Both are outputs of the app's staging stack.
2. Fill in the `backend "s3"` block in `main.tf`, or remove it to keep state locally.
3. Copy `terraform.tfvars.example` to `terraform.tfvars` and fill it in.
4. Using credentials for the **seller** account, run:

   ```bash
   terraform init
   terraform apply
   ```

5. Send these back to the app team:
   - `seller_account_id` (output)
   - `api_access_role_arn` (output)
   - the listing's **product code**
   - the **dimension name** for the camera count, for example `cameras`

The listing's fulfillment URL must be `https://api.olympusvisions.com/api/v1/marketplace/register`.

## Order of operations

The app stack must allow the seller account to send events to its bus. Its `marketplace_seller_account_id` variable controls this. Until that is set, events forwarded by this stack fail delivery. So the order is:

1. The app team applies with empty seller values. This creates the task role and the bus.
2. The CTO applies this stack.
3. The app team sets `marketplace_seller_account_id` and `marketplace_seller_role_arn` and applies again.

## Notes

- The trust policy names one role ARN. If the app's task role is ever deleted and recreated, apply this stack again.
- AWS does not deliver an event onward from the receiving account to a third account. Here the second hop, from us-east-1 to eu-west-1, stays inside the app account, which AWS allows.
