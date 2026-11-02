// Package tailprobe defines the authenticated, single-purpose bridge protocol.
package tailprobe

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// ValidToken permits fixed-size, lowercase hex values only.
func ValidToken(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func mac(key []byte, domain string, fields ...string) string {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(domain))
	for _, field := range fields {
		h.Write([]byte{0})
		h.Write([]byte(field))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// DeviceTag is an opaque pseudonym; the Tailscale node ID stays on the bridge.
func DeviceTag(key []byte, stableID string) string {
	return mac(key, "workdeck-tailnet-device-v1", stableID)
}
func Proof(key []byte, challenge, device string) string {
	return mac(key, "workdeck-tailnet-probe-v1", challenge, device)
}
func Verify(key []byte, challenge, device, proof string) bool {
	if len(key) < 32 || !ValidToken(challenge, 48) || !ValidToken(device, 64) || !ValidToken(proof, 64) {
		return false
	}
	return hmac.Equal([]byte(Proof(key, challenge, device)), []byte(strings.ToLower(proof)))
}
