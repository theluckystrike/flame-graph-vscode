// A small Go program that writes a CPU profile and a heap profile with runtime/pprof.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"runtime/pprof"
	"sort"
	"strings"
)

type Item struct {
	Name  string  `json:"name"`
	Price float64 `json:"price"`
	Tags  []string `json:"tags"`
}

var keep [][]byte

func makeItems(n int) []Item {
	items := make([]Item, n)
	for i := range items {
		items[i] = Item{Name: fmt.Sprintf("item-%d", i), Price: float64(i%997) / 3, Tags: []string{"a", "b", strings.Repeat("x", i%17)}}
	}
	return items
}

func encode(items []Item) []byte {
	b, _ := json.Marshal(items)
	return b
}

func decode(b []byte) []Item {
	var out []Item
	_ = json.Unmarshal(b, &out)
	return out
}

func hashAll(items []Item) [32]byte {
	var h [32]byte
	for _, it := range items {
		h = sha256.Sum256(append(h[:], it.Name...))
	}
	return h
}

func sortItems(items []Item) {
	sort.Slice(items, func(i, j int) bool { return items[i].Price < items[j].Price || (items[i].Price == items[j].Price && items[i].Name < items[j].Name) })
}

func work(rounds int) {
	for r := 0; r < rounds; r++ {
		items := makeItems(40000)
		b := encode(items)
		keep = append(keep, b[:len(b)/8])
		back := decode(b)
		sortItems(back)
		_ = hashAll(back)
	}
}

func main() {
	cpu, _ := os.Create(os.Args[1])
	pprof.StartCPUProfile(cpu)
	work(40)
	pprof.StopCPUProfile()
	cpu.Close()
	runtime.GC()
	heap, _ := os.Create(os.Args[2])
	pprof.WriteHeapProfile(heap)
	heap.Close()
}
