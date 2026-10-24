package plugin

import (
	"auto-switcher-pro/internal/analytics"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	tempDir, err := os.MkdirTemp("", "plugin-tests-*")
	if err == nil {
		if _, resetErr := analytics.ResetDBForTest(filepath.Join(tempDir, "test_rotations.db")); resetErr != nil {
			fmt.Fprintf(os.Stderr, "TestMain: ResetDBForTest failed: %v\n", resetErr)
		}
	}
	code := m.Run()
	if tempDir != "" {
		_ = os.RemoveAll(tempDir)
	}
	os.Exit(code)
}
