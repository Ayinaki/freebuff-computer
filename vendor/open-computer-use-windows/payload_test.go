package main

import "testing"

func TestTextPayloadsReachRuntimeWithoutNormalization(t *testing.T) {
	for _, tool := range []string{"type_text", "set_value"} {
		for _, payload := range []string{" leading", "trailing ", " \t\n ", "Ω 日本語"} {
			t.Run(tool+"/"+payload, func(t *testing.T) {
				s := newService()
				snap := &appSnapshot{App: appDescriptor{Name: "fixture", BundleIdentifier: "fixture@window:1:2:3", PID: 1}, WindowID: "2", Elements: []elementRecord{{Index: 1}}}
				s.rememberSnapshot("fixture", snap)
				called := false
				s.run = func(request psRequest) (*psResponse, error) {
					called = true
					got := request.Text
					if tool == "set_value" {
						got = request.Value
					}
					if got != payload {
						t.Fatalf("runtime received %q, want exact %q", got, payload)
					}
					if request.App != snap.App.BundleIdentifier {
						t.Fatalf("action lost window binding: %q", request.App)
					}
					return &psResponse{OK: true, Snapshot: snap}, nil
				}
				result := s.callTool(tool, map[string]any{"app": "fixture", "element_index": "1", "text": payload, "value": payload})
				if result.IsError || !called {
					t.Fatalf("payload did not dispatch: %#v", result)
				}
			})
		}
	}
}
