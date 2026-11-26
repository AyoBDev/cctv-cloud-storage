# ---------------------------------------------------------------------------
# Cross-account AWS Marketplace access
# When the listing lives in a separate seller account, the API assumes that
# account's role (modules/marketplace-seller) for ResolveCustomer and
# GetEntitlements. The direct aws-marketplace:* grant in main.tf stays for the
# same-account case.
# ---------------------------------------------------------------------------
resource "aws_iam_role_policy" "ecs_task_assume_marketplace_seller" {
  count = var.marketplace_seller_role_arn == "" ? 0 : 1

  name = "assume-marketplace-seller-role"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = var.marketplace_seller_role_arn
    }]
  })
}
