aws_region  = "eu-west-1"
cors_origin = "http://localhost:3001"
ses_domain  = "cctv-cloud.local"

# AWS Marketplace: the listing lives in a separate seller account.
marketplace_seller_account_id = "021891609235"
marketplace_seller_role_arn   = "arn:aws:iam::021891609235:role/marketplace-api-access"
marketplace_product_code      = "ceocu3is6rfd8vo9zsr9gzcvz"

# The listing uses Free pricing (AWS does not allow changing it later).
marketplace_pricing_model     = "free"
marketplace_free_camera_limit = 5
