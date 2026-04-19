.PHONY: recipe-basic recipe-timeout recipe-chained recipe-handoff-claim recipe-handoff-timeout recipe-basic-hq recipe-timeout-hq recipe-chained-hq recipe-handoff-claim-hq recipe-handoff-timeout-hq all-recipes clean list preview-basic preview-timeout preview-chained preview-handoff-claim preview-handoff-timeout recipe-basic-live recipe-timeout-live recipe-chained-live recipe-handoff-claim-live recipe-handoff-timeout-live all-live live-from-latest

# Per-recipe synthetic scenes — low quality for iteration; bump to -qh
# for sharing.

recipe-basic:
	manim -ql scenes/recipe_basic.py RecipeBasic

recipe-timeout:
	manim -ql scenes/recipe_timeout.py RecipeTimeout

recipe-chained:
	manim -ql scenes/recipe_chained.py RecipeChained

recipe-handoff-claim:
	manim -ql scenes/recipe_handoff.py RecipeHandoffClaim

recipe-handoff-timeout:
	manim -ql scenes/recipe_handoff.py RecipeHandoffTimeout

all-recipes: recipe-basic recipe-timeout recipe-chained recipe-handoff-claim recipe-handoff-timeout

# High-quality renders (scale up wall time; use for final versions).

recipe-basic-hq:
	manim -qh scenes/recipe_basic.py RecipeBasic

recipe-timeout-hq:
	manim -qh scenes/recipe_timeout.py RecipeTimeout

recipe-chained-hq:
	manim -qh scenes/recipe_chained.py RecipeChained

recipe-handoff-claim-hq:
	manim -qh scenes/recipe_handoff.py RecipeHandoffClaim

recipe-handoff-timeout-hq:
	manim -qh scenes/recipe_handoff.py RecipeHandoffTimeout

# Preview in the default system player (opens window after render).

preview-basic:
	manim -pql scenes/recipe_basic.py RecipeBasic

preview-timeout:
	manim -pql scenes/recipe_timeout.py RecipeTimeout

preview-chained:
	manim -pql scenes/recipe_chained.py RecipeChained

preview-handoff-claim:
	manim -pql scenes/recipe_handoff.py RecipeHandoffClaim

preview-handoff-timeout:
	manim -pql scenes/recipe_handoff.py RecipeHandoffTimeout

# Live renders — drive scenes from translated testnet snapshots in
# `viz/data/recipe-*-live-NN.json`. Which run is selected is controlled
# by the RECIPE_LIVE_RUN env var (default "01"):
#
#   make recipe-basic-live                     # renders live-01
#   RECIPE_LIVE_RUN=02 make recipe-basic-live  # renders live-02
#
# To regenerate timelines from the newest snapshotted runs and render all
# of them: `make live-from-latest`.

recipe-basic-live:
	manim -ql scenes/recipe_basic.py RecipeBasicLive

recipe-timeout-live:
	manim -ql scenes/recipe_timeout.py RecipeTimeoutLive

recipe-chained-live:
	manim -ql scenes/recipe_chained.py RecipeChainedLive

recipe-handoff-claim-live:
	manim -ql scenes/recipe_handoff.py RecipeHandoffClaimLive

recipe-handoff-timeout-live:
	manim -ql scenes/recipe_handoff.py RecipeHandoffTimeoutLive

all-live: recipe-basic-live recipe-timeout-live recipe-chained-live recipe-handoff-claim-live recipe-handoff-timeout-live

# Regenerate timeline JSONs from the newest snapshotted run per recipe,
# then render every Live scene against them. Composes the snapshot→viz
# pipeline so a single invocation goes from on-chain artifacts to MP4s.
live-from-latest:
	cd .. && ./scripts/demo.sh translate --run latest
	$(MAKE) all-live

list:
	@ls scenes/*.py

clean:
	rm -rf media/
