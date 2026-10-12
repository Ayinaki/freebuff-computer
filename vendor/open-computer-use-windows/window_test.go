package main

import "testing"

func TestWindowSnapshotsDoNotAliasThroughProcessNameOrPID(t *testing.T) {
	service := newService()
	first := &appSnapshot{App: appDescriptor{Name: "vivaldi", PID: 42, BundleIdentifier: "vivaldi@window:42:100:123"}, WindowID: "100", Elements: []elementRecord{{Index: 7, Name: "first"}}}
	second := &appSnapshot{App: appDescriptor{Name: "vivaldi", PID: 42, BundleIdentifier: "vivaldi@window:42:200:123"}, WindowID: "200", Elements: []elementRecord{{Index: 7, Name: "second"}}}
	service.rememberSnapshot(first.App.BundleIdentifier, first)
	service.rememberSnapshot(second.App.BundleIdentifier, second)
	for _, query := range []string{"vivaldi", "42"} {
		if service.currentSnapshot(query) != nil {
			t.Fatalf("shared process alias %q must not select an arbitrary window", query)
		}
	}
	if service.currentSnapshot(first.App.BundleIdentifier) != first || service.currentSnapshot(second.App.BundleIdentifier) != second {
		t.Fatal("window snapshots must remain independent")
	}
	record, err := lookupElement(service.currentSnapshot(first.App.BundleIdentifier), "7")
	if err != nil || record.Name != "first" {
		t.Fatalf("same numeric index in second window contaminated first: %#v %v", record, err)
	}
}

func TestWindowSnapshotHeaderPreservesExplicitIdentity(t *testing.T) {
	snapshot := &appSnapshot{App: appDescriptor{Name: "vivaldi", PID: 42, BundleIdentifier: "vivaldi@window:42:100:123"}, WindowID: "100", WindowTitle: "Practice"}
	text := snapshot.renderedText()
	if text != "App=vivaldi@window:42:100:123 (pid 42)\nWindow: \"Practice\", App: vivaldi.\nWindow-ID: 100" {
		t.Fatalf("unexpected window-bound snapshot header: %q", text)
	}
}
