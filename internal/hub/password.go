package hub

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/pbkdf2"
)

const passwordPrefix = "$workdeck$pbkdf2-sha256$v1$"
const passwordIterations = 600000

const passwordPolicyMessage = "密码至少 6 位，且同时包含英文字母和数字，大小写不限"

func validatePassword(password string) error {
	letter, digit := false, false
	for _, character := range password {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' {
			letter = true
		}
		if character >= '0' && character <= '9' {
			digit = true
		}
	}
	if utf8.RuneCountInString(password) < 6 || !letter || !digit {
		return errors.New(passwordPolicyMessage)
	}
	return nil
}

// Versioned PBKDF2 hashes support arbitrary password bytes without bcrypt's
// 72-byte input bound. Existing bcrypt accounts remain readable until changed.
func hashPassword(password string) ([]byte, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	key := pbkdf2.Key([]byte(password), salt, passwordIterations, 32, sha256.New)
	encoded := passwordPrefix + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key)
	return []byte(encoded), nil
}
func comparePassword(stored []byte, password string) error {
	if !bytes.HasPrefix(stored, []byte(passwordPrefix)) {
		if len(password) > 72 {
			return bcrypt.ErrMismatchedHashAndPassword
		}
		return bcrypt.CompareHashAndPassword(stored, []byte(password))
	}
	parts := strings.Split(string(stored[len(passwordPrefix):]), "$")
	if len(parts) != 2 {
		return errors.New("invalid password hash")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[0])
	if err != nil || len(salt) != 16 {
		return errors.New("invalid password salt")
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[1])
	if err != nil || len(expected) != 32 {
		return errors.New("invalid password hash")
	}
	actual := pbkdf2.Key([]byte(password), salt, passwordIterations, len(expected), sha256.New)
	if subtle.ConstantTimeCompare(actual, expected) != 1 {
		return errors.New("password mismatch")
	}
	return nil
}
