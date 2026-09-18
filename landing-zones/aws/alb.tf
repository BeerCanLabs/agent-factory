# HTTPS only. Port 80 exists solely to redirect.
resource "aws_lb" "factory" {
  name                       = local.name
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.service[*].id
  drop_invalid_header_fields = true
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
  description       = "redirect to HTTPS"
}

resource "aws_lb_target_group" "control" {
  name        = "${local.name}-cp"
  port        = 8088
  protocol    = "HTTP"
  vpc_id      = aws_vpc.factory.id
  target_type = "ip"
  health_check {
    path = "/healthz"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.factory.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.factory.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
