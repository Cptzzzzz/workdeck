package protocol

import "testing"

func TestCodexOptionsRejectUnsafeInputs(t *testing.T) {
	valid := CodexLaunchOptions{ProxyMode: "inherit", Approval: "on-request", Sandbox: "workspace-write"}
	if e := valid.Validate(); e != nil {
		t.Fatal(e)
	}
	cases := []CodexLaunchOptions{valid, valid, valid, valid, valid}
	cases[0].ProxyMode = "custom"
	cases[0].Proxy = "file:///etc/passwd"
	cases[1].Approval = "always; rm"
	cases[2].Resume = "$(touch /tmp/no)"
	cases[3].Proxy = "http://secret.test:1234"
	cases[4].Sandbox = "invalid"
	for _, o := range cases {
		if o.Validate() == nil {
			t.Fatal("unsafe options accepted")
		}
	}
}
