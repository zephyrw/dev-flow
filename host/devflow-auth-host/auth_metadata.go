package main

import (
	"encoding/json"
	"time"
)

type SafeAuthMetadata struct {
	AccessExpiresAt      *string `json:"access_expires_at,omitempty"`
	RefreshExpiresAt     *string `json:"refresh_expires_at,omitempty"`
	HasRefreshCredential *bool   `json:"has_refresh_credential"`
	MetadataStatus       string  `json:"metadata_status"`
	RefreshExpirySource  string  `json:"refresh_expiry_source"`
}

// ExtractSafeMetadata securely extracts only non-sensitive expiration and presence metadata from credential secret.
// It never leaks tokens, passwords, or the raw secret payload.
func ExtractSafeMetadata(secretBytes []byte) SafeAuthMetadata {
	result := SafeAuthMetadata{
		MetadataStatus:      "unrecognized",
		RefreshExpirySource: "not_provided",
	}

	if len(secretBytes) == 0 {
		return result
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(secretBytes, &parsed); err != nil {
		// Not JSON or corrupted, return unrecognized safely
		return result
	}

	// 只有当存在有效 string 类型的 refresh_token 且非空时才设置 true；
	// 若明确为空字符串设置 false；若为 null、非 string 或未知类型，保留 nil，绝不武断推导为 false
	if val, ok := parsed["refresh_token"]; ok && val != nil {
		if str, isStr := val.(string); isStr {
			if len(str) > 0 {
				t := true
				result.HasRefreshCredential = &t
			} else {
				f := false
				result.HasRefreshCredential = &f
			}
		}
	}

	// Check access expiry
	var accessExpTime *time.Time
	if val, ok := parsed["expiry"]; ok && val != nil {
		if str, isStr := val.(string); isStr {
			if t, err := time.Parse(time.RFC3339, str); err == nil {
				accessExpTime = &t
			}
		}
	}
	if accessExpTime == nil {
		if val, ok := parsed["expires_at"]; ok && val != nil {
			if num, isNum := val.(float64); isNum && num > 0 {
				var t time.Time
				if num > 1e11 {
					t = time.UnixMilli(int64(num)).UTC()
				} else {
					t = time.Unix(int64(num), 0).UTC()
				}
				accessExpTime = &t
			} else if str, isStr := val.(string); isStr {
				if t, err := time.Parse(time.RFC3339, str); err == nil {
					accessExpTime = &t
				}
			}
		}
	}

	if accessExpTime != nil {
		s := accessExpTime.Format(time.RFC3339)
		result.AccessExpiresAt = &s
	}

	// Check refresh expiry if explicitly reported by provider
	var refreshExpTime *time.Time
	if val, ok := parsed["refresh_expires_at"]; ok && val != nil {
		if str, isStr := val.(string); isStr {
			if t, err := time.Parse(time.RFC3339, str); err == nil {
				refreshExpTime = &t
			}
		} else if num, isNum := val.(float64); isNum && num > 0 {
			var t time.Time
			if num > 1e11 {
				t = time.UnixMilli(int64(num)).UTC()
			} else {
				t = time.Unix(int64(num), 0).UTC()
			}
			refreshExpTime = &t
		}
	}

	if refreshExpTime != nil {
		s := refreshExpTime.Format(time.RFC3339)
		result.RefreshExpiresAt = &s
		result.RefreshExpirySource = "provider_reported"
	}

	// 校验 token 字段有效性：access_token 必须是非空 string，且不能是 null/空对象
	var hasValidAccessToken bool
	if tok, ok := parsed["access_token"]; ok && tok != nil {
		if str, isStr := tok.(string); isStr && len(str) > 0 {
			hasValidAccessToken = true
		}
	}
	var hasValidTokenType bool
	if tt, ok := parsed["token_type"]; ok && tt != nil {
		if str, isStr := tt.(string); isStr && len(str) > 0 {
			hasValidTokenType = true
		}
	}

	// 只有具备合法 token 字段且具备可验证的过期时间或明确的合法 refresh 存在性证明时，才认作 verified
	if (hasValidTokenType || hasValidAccessToken) && (result.AccessExpiresAt != nil || (result.HasRefreshCredential != nil && *result.HasRefreshCredential)) {
		result.MetadataStatus = "verified"
	}

	return result
}
