#!/bin/bash
#
# Launch Authelia in Docker with preconfigured test users
#
# Creates two test users:
#   - admin / admin123 (in admins group)
#   - user / user123 (in users group)
#
# Usage:
#   ./authelia.sh [start|stop|restart|logs]
#
# The Authelia instance will be available at:
#   http://auth.local:9091
#

set -euo pipefail

CONTAINER_NAME="signalk-authelia-test"
NETWORK_NAME="signalk-test-net"
CONFIG_DIR="/tmp/authelia-test-config"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

usage() {
    sed -n '2,/^$/p' "$0" | grep '^#' | sed 's/^# \?//'
    exit 0
}

setup_config() {
    log "Setting up Authelia configuration..."
    
    # Create config directory
    mkdir -p "$CONFIG_DIR"
    
    # Generate self-signed certificate for testing
    log "Generating self-signed certificate..."
    openssl req -x509 -newkey rsa:4096 -keyout "$CONFIG_DIR/key.pem" -out "$CONFIG_DIR/cert.pem" \
        -days 365 -nodes -subj "/CN=auth.local" 2>/dev/null
    
    # Generate RSA key pair for OIDC JWT signing and convert to traditional format
    log "Generating RSA key for OIDC..."
    openssl genrsa -out "$CONFIG_DIR/oidc-rsa-temp.pem" 4096 2>/dev/null
    openssl rsa -in "$CONFIG_DIR/oidc-rsa-temp.pem" -out "$CONFIG_DIR/oidc-rsa.pem" 2>/dev/null
    rm -f "$CONFIG_DIR/oidc-rsa-temp.pem"
    
    # Create users_database.yml with bcrypt hashed passwords
    # admin123 hashed with bcrypt cost 12
    # user123 hashed with bcrypt cost 12
    cat > "$CONFIG_DIR/users_database.yml" <<'EOF'
users:
  admin:
    displayname: "Admin User"
    password: "$2b$12$km8qtcoqWHQJPxXDaLh8beYlw8.NzXE9ppGZnYMsfjKSfl76eeEz."
    email: admin@example.com
    groups:
      - admins
  user:
    displayname: "Regular User"
    password: "$2b$12$ha7jGMi9zZ7QHY6/yg6al.3tZadLd2woYQF9hfCB5fs2IdDxoeW.6"
    email: user@example.com
    groups:
      - users
EOF

    # Create main configuration.yml (part 1)
    cat > "$CONFIG_DIR/configuration.yml" <<'EOF'
---
server:
  address: 'tcp://0.0.0.0:9091'
  tls:
    certificate: /config/cert.pem
    key: /config/key.pem

log:
  level: info

totp:
  disable: true

webauthn:
  disable: true

authentication_backend:
  file:
    path: /config/users_database.yml

access_control:
  default_policy: one_factor

session:
  secret: insecure_session_secret_for_testing_only
  cookies:
    - domain: 'auth.local'
      authelia_url: 'https://auth.local:9091'

identity_providers:
  oidc:
    hmac_secret: a_very_important_hmac_secret_for_testing_only_min32chars
    jwks:
      - key: |
EOF

    # Append the RSA key with proper indentation
    sed 's/^/          /' "$CONFIG_DIR/oidc-rsa.pem" >> "$CONFIG_DIR/configuration.yml"
    
    # Append rest of configuration
    cat >> "$CONFIG_DIR/configuration.yml" <<'EOF'
    clients:
      - client_id: 'signalk-client'
        client_name: 'SignalK Server'
        client_secret: '$pbkdf2-sha512$310000$c8p78n7pUMln0jzvd4aK4Q$JNRBzwAo0ek5qKn50cFzzvE9RXV88h1wJn5KGiHrD0YKtZaR5nYeCU3I'
        public: false
        authorization_policy: 'one_factor'
        redirect_uris:
          - 'http://localhost:3000/admin/login'
        scopes:
          - 'openid'
          - 'profile'
          - 'email'
        userinfo_signed_response_alg: 'none'

regulation:
  max_retries: 5
  find_time: 2m
  ban_time: 5m

storage:
  encryption_key: a_very_important_secret_for_testing_only_min32
  local:
    path: /config/db.sqlite3

identity_validation:
  reset_password:
    jwt_secret: a_very_important_jwt_secret_for_testing_only_min32

notifier:
  disable_startup_check: true
  filesystem:
    filename: /config/notification.txt
EOF

    log_success "Configuration files created in $CONFIG_DIR"
}

create_network() {
    if ! docker network inspect "$NETWORK_NAME" &>/dev/null; then
        log "Creating Docker network: $NETWORK_NAME"
        docker network create "$NETWORK_NAME"
        log_success "Network created"
    else
        log "Network $NETWORK_NAME already exists"
    fi
}

start_authelia() {
    # Check if auth.local resolves to 127.0.0.1
    log "Checking if auth.local resolves to 127.0.0.1..."
    if ! grep -q "127.0.0.1.*auth.local" /etc/hosts; then
        log_error "auth.local is not configured in /etc/hosts"
        echo ""
        log "Please add the following line to /etc/hosts:"
        echo "  127.0.0.1 auth.local"
        echo ""
        log "You can do this with:"
        echo "  echo '127.0.0.1 auth.local' | sudo tee -a /etc/hosts"
        exit 1
    fi
    log_success "auth.local is correctly configured"
    
    # Check if container already exists
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_warn "Container $CONTAINER_NAME already exists"
        if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            log_warn "Container is already running"
            return 0
        else
            log "Starting existing container..."
            docker start "$CONTAINER_NAME"
            log_success "Container started"
            return 0
        fi
    fi

    setup_config
    create_network

    log "Starting Authelia container..."
    docker run -d \
        --name "$CONTAINER_NAME" \
        --network "$NETWORK_NAME" \
        -p 9091:9091 \
        -v "$CONFIG_DIR:/config" \
        authelia/authelia:latest

    log_success "Authelia started successfully"
    echo ""
    log "Authelia is available at: https://auth.local:9091"
    echo ""
    log "Test users:"
    echo "  admin / admin123 (admins group)"
    echo "  user / user123 (users group)"
    echo ""
    log "OIDC Configuration:"
    echo "  Client ID: signalk-client"
    echo "  Client Secret: test-secret-please-change-in-production"
    echo "  Issuer: https://auth.local:9091"
    echo "  Authorization endpoint: https://auth.local:9091/api/oidc/authorization"
    echo "  Token endpoint: https://auth.local:9091/api/oidc/token"
    echo "  Userinfo endpoint: https://auth.local:9091/api/oidc/userinfo"
    echo ""
    log "Use './authelia.sh logs' to view container logs"
}

stop_authelia() {
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log "Stopping Authelia container..."
        docker stop "$CONTAINER_NAME"
        log_success "Container stopped"
    else
        log_warn "Container is not running"
    fi
}

remove_authelia() {
    stop_authelia
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log "Removing container..."
        docker rm "$CONTAINER_NAME"
        log_success "Container removed"
    fi
    
    if [ -d "$CONFIG_DIR" ]; then
        log "Removing configuration directory..."
        rm -rf "$CONFIG_DIR"
        log_success "Configuration removed"
    fi
}

show_logs() {
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker logs -f "$CONTAINER_NAME"
    else
        log_error "Container is not running"
        exit 1
    fi
}

show_status() {
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_success "Authelia is running"
        echo ""
        docker ps --filter "name=$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        echo ""
        log "URL: https://auth.local:9091"
        log "Config: $CONFIG_DIR"
    else
        log_warn "Authelia is not running"
        if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            log "Container exists but is stopped. Use './authelia.sh start' to start it."
        else
            log "Container does not exist. Use './authelia.sh start' to create and start it."
        fi
    fi
}

# Main script
case "${1:-start}" in
    start)
        start_authelia
        ;;
    stop)
        stop_authelia
        ;;
    restart)
        stop_authelia
        sleep 2
        start_authelia
        ;;
    remove|clean)
        remove_authelia
        ;;
    logs)
        show_logs
        ;;
    status)
        show_status
        ;;
    -h|--help)
        usage
        ;;
    *)
        log_error "Unknown command: $1"
        usage
        exit 1
        ;;
esac
