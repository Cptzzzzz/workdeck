package agent

import (
	"context"
	"fmt"
	"strconv"

	"golang.org/x/time/rate"
	"workdeck/internal/fileprotocol"
)

const (
	defaultFileRate = 8 << 20
	minFileRate     = 256 << 10
	maxFileRate     = 1 << 30
	fileRateBurst   = 2 * fileprotocol.MaxChunk
)

func configuredFileRate(value string) (int, error) {
	if value == "" {
		return defaultFileRate, nil
	}
	bytes, err := strconv.ParseInt(value, 10, 64)
	if err != nil || bytes < minFileRate || bytes > maxFileRate {
		return 0, fmt.Errorf("WORKDECK_FILE_RATE_BYTES_PER_SEC must be an integer between %d and %d", minFileRate, maxFileRate)
	}
	return int(bytes), nil
}

// A limiter belongs to the Agent and operating-system UID, so separate file
// connections, terminals, and worker restarts cannot bypass the shared cap.
func (a *Agent) fileLimiter(uid string) *rate.Limiter {
	a.fileRatesMu.Lock()
	defer a.fileRatesMu.Unlock()
	if a.fileRates == nil {
		a.fileRates = make(map[string]*rate.Limiter)
	}
	if a.fileRates[uid] == nil {
		limit := a.fileRateBytes
		if limit == 0 {
			limit = defaultFileRate
		}
		a.fileRates[uid] = rate.NewLimiter(rate.Limit(limit), fileRateBurst)
	}
	return a.fileRates[uid]
}

func (w *fileWorkerClient) waitFileBytes(ctx context.Context, n int) error {
	if w.fileLimiter == nil || n == 0 {
		return ctx.Err()
	}
	return w.fileLimiter.WaitN(ctx, n)
}
