"""Unit tests for the folded-snapshot (materialized view) logic."""
from tithon.folding import ExecutionFold, StreamBuf, fold_messages


def stream(name, text):
    return ("stream", {"name": name, "text": text})


class TestStreamBuf:
    def test_plain_lines(self):
        b = StreamBuf()
        b.write("a\nb\n")
        assert b.text == "a\nb\n"

    def test_carriage_return_overwrites(self):
        b = StreamBuf()
        b.write("\r 10%")
        b.write("\r 20%")
        b.write("\r100% done")
        assert b.text == "100% done"

    def test_partial_overwrite_keeps_tail(self):
        b = StreamBuf()
        b.write("hello")
        b.write("\rHE")
        assert b.text == "HEllo"

    def test_cr_across_write_boundary(self):
        b = StreamBuf()
        b.write("line1\n50%")
        b.write("\r100%")
        assert b.text == "line1\n100%"

    def test_backspace(self):
        b = StreamBuf()
        b.write("abc\b\bX")
        assert b.text == "aXc"

    def test_empty(self):
        assert StreamBuf().text == ""


class TestExecutionFold:
    def test_consecutive_same_stream_merges(self):
        out = fold_messages([stream("stdout", "a"), stream("stdout", "b")])
        assert out == [{"output_type": "stream", "name": "stdout", "text": "ab"}]

    def test_stdout_stderr_separate_items(self):
        out = fold_messages([stream("stdout", "o"), stream("stderr", "e"), stream("stdout", "o2")])
        assert [o["name"] for o in out] == ["stdout", "stderr", "stdout"]

    def test_tqdm_like_folds_to_single_line(self):
        msgs = [stream("stderr", f"\r{i}/100") for i in range(101)]
        msgs.append(stream("stderr", "\r100/100 done\n"))
        out = fold_messages(msgs)
        assert len(out) == 1
        assert out[0]["text"] == "100/100 done\n"

    def test_clear_output_immediate(self):
        out = fold_messages([stream("stdout", "x"), ("clear_output", {"wait": False}),
                             stream("stdout", "y")])
        assert out == [{"output_type": "stream", "name": "stdout", "text": "y"}]

    def test_clear_output_wait_defers_until_next_output(self):
        f = ExecutionFold()
        f.apply(*stream("stdout", "x"))
        f.apply("clear_output", {"wait": True})
        assert f.outputs()[0]["text"] == "x"  # not cleared yet
        f.apply(*stream("stdout", "y"))
        assert f.outputs() == [{"output_type": "stream", "name": "stdout", "text": "y"}]

    def test_update_display_data_replaces_by_display_id(self):
        out = fold_messages([
            ("display_data", {"data": {"text/plain": "v0"}, "metadata": {},
                              "transient": {"display_id": "d1"}}),
            stream("stdout", "between"),
            ("update_display_data", {"data": {"text/plain": "v9"}, "metadata": {},
                                     "transient": {"display_id": "d1"}}),
        ])
        assert out[0]["data"] == {"text/plain": "v9"}
        assert out[0]["display_id"] == "d1"
        assert out[1]["text"] == "between"

    def test_update_unknown_display_id_ignored(self):
        out = fold_messages([
            ("update_display_data", {"data": {"text/plain": "x"}, "metadata": {},
                                     "transient": {"display_id": "nope"}}),
        ])
        assert out == []

    def test_execute_result_and_error(self):
        out = fold_messages([
            ("execute_result", {"data": {"text/plain": "42"}, "metadata": {},
                                "execution_count": 3}),
            ("error", {"ename": "ValueError", "evalue": "bad", "traceback": ["tb"]}),
        ])
        assert out[0]["output_type"] == "execute_result"
        assert out[0]["execution_count"] == 3
        assert out[1] == {"output_type": "error", "ename": "ValueError",
                          "evalue": "bad", "traceback": ["tb"]}

    def test_artifact_ids_track_current_frame_only(self):
        """clear_output(wait)+display_data (the live-plot idiom) drops the prior
        frame's artifact id from the set, so the daemon GCs its file."""
        def frame(aid):
            return ("display_data", {"data": {"image/png": {"$tithon_artifact": {"artifact_id": aid}}},
                                     "metadata": {}})
        f = ExecutionFold()
        f.apply(*frame("png1"))
        assert f.artifact_ids() == {"png1"}
        f.apply("clear_output", {"wait": True})
        f.apply(*frame("png2"))
        assert f.artifact_ids() == {"png2"}  # png1 superseded -> GC-eligible

    def test_artifact_ids_keep_all_distinct_displays(self):
        """Intentional multi-image output (no clear) keeps every artifact."""
        def frame(aid):
            return ("display_data", {"data": {"image/png": {"$tithon_artifact": {"artifact_id": aid}}},
                                     "metadata": {}})
        out = ExecutionFold()
        out.apply(*frame("a"))
        out.apply(*frame("b"))
        assert out.artifact_ids() == {"a", "b"}

    def test_status_and_execute_input_ignored(self):
        out = fold_messages([
            ("status", {"execution_state": "busy"}),
            ("execute_input", {"code": "1+1", "execution_count": 1}),
        ])
        assert out == []

    def test_stream_after_display_starts_new_item(self):
        out = fold_messages([
            stream("stdout", "a"),
            ("display_data", {"data": {"text/plain": "d"}, "metadata": {}}),
            stream("stdout", "b"),
        ])
        assert len(out) == 3
        assert out[2]["text"] == "b"


def claim(comm_id, msg_id="req-1"):
    """The wire shape ipywidgets' Output uses to claim/release an output area."""
    return ("comm_msg", {"comm_id": comm_id,
                         "data": {"method": "update", "state": {"msg_id": msg_id}}})


def release(comm_id):
    return claim(comm_id, "")


def png(aid):
    return ("display_data", {"data": {"image/png": {"$tithon_artifact": {"artifact_id": aid}}},
                             "metadata": {}})


class TestOutputWidgetAreas:
    """RISKS #17 — an `Output` widget's clear is scoped to ITS area, not the cell."""

    def test_widget_clear_spares_sibling_outputs(self):
        # The reported shape: a tqdm bar, then a live plot repainted inside the widget.
        msgs = [("display_data", {"data": {"application/vnd.jupyter.widget-view+json": {"model_id": "bar"}},
                                  "metadata": {}})]
        for i in range(4):
            msgs += [claim("out"), ("clear_output", {"wait": True}), png(f"f{i}"), release("out")]
        out = fold_messages(msgs)
        assert len(out) == 2, out
        assert "application/vnd.jupyter.widget-view+json" in out[0]["data"]  # bar survived
        assert out[1]["data"]["image/png"]["$tithon_artifact"]["artifact_id"] == "f3"  # only latest frame

    def test_widget_frames_still_supersede_so_artifact_gc_converges(self):
        fold = ExecutionFold()
        for i in range(5):
            for m in (claim("out"), ("clear_output", {"wait": True}), png(f"f{i}"), release("out")):
                fold.apply(*m)
        assert fold.artifact_ids() == {"f4"}

    def test_cell_level_clear_still_clears_everything(self):
        out = fold_messages([
            stream("stdout", "cell text"),
            claim("out"), png("a"), release("out"),
            ("clear_output", {"wait": False}),
        ])
        assert out == []

    def test_synthetic_cell_scope_overrides_an_active_claim(self):
        """The user's "Clear Outputs" lands while a widget still holds the claim:
        it means the CELL, so it must not be captured by that widget's area."""
        from tithon.folding import SCOPE_CELL, SCOPE_KEY
        out = fold_messages([
            stream("stdout", "cell text"),
            claim("out"), png("a"),          # claim deliberately never released
            ("clear_output", {"wait": False, SCOPE_KEY: SCOPE_CELL}),
        ])
        assert out == []

    def test_streams_do_not_merge_across_areas(self):
        """Merging would let a scoped clear delete the cell's own text."""
        out = fold_messages([
            stream("stdout", "cell "),
            claim("out"), stream("stdout", "widget"), release("out"),
        ])
        assert [o["text"] for o in out] == ["cell ", "widget"]
        cleared = fold_messages([
            stream("stdout", "cell "),
            claim("out"), stream("stdout", "widget"),
            ("clear_output", {"wait": False}), release("out"),
        ])
        assert [o["text"] for o in cleared] == ["cell "]

    def test_nested_claims_restore_the_outer_area(self):
        """Two Output widgets can hold the same msg_id at once; releasing the
        inner one must hand the area back to the outer, not to the cell."""
        out = fold_messages([
            claim("a"), claim("b"), release("b"),
            png("x"),                                  # belongs to `a`, not the cell
            ("clear_output", {"wait": False}),         # scoped to `a` -> drops x
            stream("stdout", "still here"),
        ])
        assert [o["output_type"] for o in out] == ["stream"]

    def test_comm_close_releases_a_claim_left_open(self):
        out = fold_messages([
            stream("stdout", "cell "),
            claim("out"),
            ("comm_close", {"comm_id": "out"}),
            ("clear_output", {"wait": False}),   # no claim left -> cell-wide
        ])
        assert out == []

    def test_owner_never_reaches_the_wire(self):
        out = fold_messages([claim("out"), png("a"), stream("stdout", "t")])
        assert all(not k.startswith("_") for o in out for k in o)

    def test_interleaved_widget_frames_do_not_restart_the_cell_stream(self):
        """A `\\r` progress line printed beside a live plot must stay ONE folding
        line. The plot lands between the prints only because the figure is not
        (yet) nested inside the widget; each area folds independently."""
        msgs = []
        for i in range(5):
            msgs += [claim("out"), ("clear_output", {"wait": True}), png(f"f{i}"), release("out"),
                     stream("stdout", f"\rStep {i}")]
        out = fold_messages(msgs)
        assert [o["output_type"] for o in out] == ["stream", "display_data"], out
        assert out[0]["text"] == "Step 4"     # \r folded in place, not 5 lines

    def test_same_area_display_still_breaks_a_stream_run(self):
        """Skipping OTHER areas must not skip our own — Jupyter starts a new
        stream item when a real output interrupts it within the same area."""
        out = fold_messages([
            stream("stdout", "a"),
            ("display_data", {"data": {"text/plain": "d"}, "metadata": {}}),
            stream("stdout", "b"),
        ])
        assert [o["output_type"] for o in out] == ["stream", "display_data", "stream"]
