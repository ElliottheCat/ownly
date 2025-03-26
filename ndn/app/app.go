//go:build js && wasm

package app

import (
	"crypto/cipher"
	"fmt"
	"syscall/js"
	"time"

	"github.com/named-data/ndnd/std/ndn"
	"github.com/named-data/ndnd/std/object/storage"
	"github.com/named-data/ndnd/std/security/keychain"
	jsutil "github.com/named-data/ndnd/std/utils/js"
)

type App struct {
	face     ndn.Face
	engine   ndn.Engine
	store    ndn.Store
	keychain ndn.KeyChain

	// Encryption keys
	psk []byte
	dsk []byte
	aes cipher.Block
	ivb uint64

	// Pending DSK requests -> cancel function
	dskReqs map[string]*time.Timer
}

var _ndnd_store_js = js.Global().Get("_ndnd_store_js")
var _ndnd_keychain_js = js.Global().Get("_ndnd_keychain_js")

// function(connected: boolean, router: string): void
var _ndnd_conn_change_js = js.Global().Get("_ndnd_conn_change_js")

func NewApp() *App {
	// Setup JS shim store
	store := storage.NewJsStore(_ndnd_store_js)

	// Setup JS shim keychain
	kc, err := keychain.NewKeyChainJS(_ndnd_keychain_js, store)
	if err != nil {
		panic(err)
	}

	// Insert trust anchor
	if err = kc.InsertCert(testbedRootCert); err != nil {
		panic(err)
	}

	return &App{
		store:    store,
		keychain: kc,
		dskReqs:  make(map[string]*time.Timer),
	}
}

func NewNodeApp() *App {
	// NodeApp currently only supports consumer mode.
	// If we want producer mode, we need a real store implementation.
	// FS already works but badger may be too slow.
	store := storage.NewMemoryStore()

	// Setup directory keychain
	// TODO: make this path configurable, maybe env variable
	kc, err := keychain.NewKeyChainDir("./keychain", store)
	if err != nil {
		panic(err)
	}

	// Insert trust anchor
	if err = kc.InsertCert(testbedRootCert); err != nil {
		panic(err)
	}

	return &App{
		store:    store,
		keychain: kc,
		dskReqs:  make(map[string]*time.Timer),
	}
}

func (a *App) String() string {
	return "app"
}

func (a *App) JsApi() js.Value {
	api := map[string]any{
		// has_testbed_key(): Promise<boolean>;
		"has_testbed_key": jsutil.AsyncFunc(func(this js.Value, p []js.Value) (any, error) {
			key, _, _ := a.GetTestbedKey()
			return key != nil, nil
		}),

		// get_identity_name(): Promise<string>;
		"get_identity_name": jsutil.AsyncFunc(func(this js.Value, p []js.Value) (any, error) {
			key, _, _ := a.GetTestbedKey()
			if key == nil {
				return nil, fmt.Errorf("no testbed key")
			}
			return js.ValueOf(key.KeyName().Prefix(-2).String()), nil
		}),

		// connect_testbed(): Promise<void>;
		"connect_testbed": jsutil.AsyncFunc(func(this js.Value, p []js.Value) (any, error) {
			return nil, a.ConnectTestbed()
		}),

		// ndncert_email(email: string, code: (status: string) => Promise<string>): Promise<void>;
		"ndncert_email": jsutil.AsyncFunc(func(this js.Value, p []js.Value) (any, error) {
			return nil, a.NdncertEmail(p[0].String(), func(status string) string {
				code, err := jsutil.Await(p[1].Invoke(status))
				if err != nil {
					return ""
				}
				return code.String()
			})
		}),

		// join_workspace(wksp: string, create: boolean): Promise<string>;
		"join_workspace": jsutil.AsyncFunc(func(this js.Value, p []js.Value) (any, error) {
			return a.JoinWorkspace(p[0].String(), p[1].Bool())
		}),

		// is_workspace_owner(wksp: string): Promise<boolean>;
		"is_workspace_owner": jsutil.AsyncFunc(func(this js.Value, p []js.Value) (any, error) {
			return a.IsWorkspaceOwner(p[0].String())
		}),

		// get_workspace(name: string): Promise<WorkspaceAPI>;
		"get_workspace": jsutil.AsyncFunc(func(this js.Value, p []js.Value) (any, error) {
			return a.GetWorkspace(p[0].String())
		}),
	}

	return js.ValueOf(api)
}
